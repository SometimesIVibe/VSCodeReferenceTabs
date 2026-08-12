import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { FileGroup, Search, SearchKind, SearchResultItem } from "./model";

/** Preview lines are trimmed then capped to this many characters. */
const MAX_LINE_LENGTH = 200;

/**
 * Raw cursor tokens that get an enclosing-symbol prefix in the display
 * label (C# property/indexer/event accessors). Any language: false
 * positives just produce a slightly-too-rich label, never a wrong search.
 */
const ACCESSOR_WORDS = new Set(["get", "set", "init", "add", "remove"]);

interface NormalizedLocation {
  uri: vscode.Uri;
  range: vscode.Range;
}

/**
 * Resolves the symbol under the cursor and runs the built-in reference /
 * implementation provider for it, producing a serializable {@link Search}.
 *
 * Returns `undefined` (after showing a user-facing message) when there is
 * no symbol at the cursor, or the provider returns no results — in both
 * cases no tab should be created.
 */
export async function runSearch(
  kind: SearchKind,
  editor: vscode.TextEditor
): Promise<Search | undefined> {
  const document = editor.document;
  const position = editor.selection.active;

  const wordRange = document.getWordRangeAtPosition(position);
  if (!wordRange) {
    void vscode.window.showWarningMessage("Reference Tabs: no symbol found at the cursor.");
    return undefined;
  }
  const word = document.getText(wordRange);
  const symbol = await composeLabel(document, wordRange.start, word);

  const command =
    kind === "references"
      ? "vscode.executeReferenceProvider"
      : "vscode.executeImplementationProvider";

  const raw = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[] | undefined
  >(command, document.uri, position);

  const normalized = normalizeLocations(raw ?? []);

  if (normalized.length === 0) {
    const kindLabel = kind === "references" ? "references" : "implementations";
    void vscode.window.showInformationMessage(
      `Reference Tabs: no ${kindLabel} found for '${symbol}'.`
    );
    return undefined;
  }

  const groups = await buildGroups(normalized);
  const totalCount = groups.reduce((sum, group) => sum + group.items.length, 0);

  return {
    id: randomUUID(),
    kind,
    symbol,
    word,
    originUri: document.uri.toString(),
    originLine: position.line,
    createdAt: Date.now(),
    groups,
    totalCount,
  };
}

/**
 * Composes the display label for the cursor word: for an accessor keyword
 * (`get`/`set`/`init`/`add`/`remove`), prefixes it with the name of the
 * innermost enclosing document symbol (e.g. `Name.get`); otherwise returns
 * `word` unchanged. Falls back to `word` whenever the symbol provider
 * returns nothing usable (no provider, empty result, or a `SymbolInformation[]`
 * result — those lack `.children`/nested ranges, so descent degrades to "no match").
 */
async function composeLabel(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string
): Promise<string> {
  if (!ACCESSOR_WORDS.has(word)) {
    return word;
  }

  let root: vscode.DocumentSymbol[] | undefined;
  try {
    root = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      "vscode.executeDocumentSymbolProvider",
      document.uri
    );
  } catch {
    return word;
  }

  const enclosing = findInnermostSymbol(root, position);
  return enclosing ? `${enclosing.name}.${word}` : word;
}

/**
 * Recursively descends `symbols` (and their `.children`) to find the
 * deepest symbol whose `range` contains `position`. Returns `undefined` if
 * `symbols` is missing/empty, or its items aren't `DocumentSymbol`-shaped
 * (e.g. a `SymbolInformation[]` result, which has no `.range`/`.children`).
 */
function findInnermostSymbol(
  symbols: vscode.DocumentSymbol[] | undefined,
  position: vscode.Position
): vscode.DocumentSymbol | undefined {
  if (!Array.isArray(symbols)) {
    return undefined;
  }

  for (const symbol of symbols) {
    if (!symbol || !(symbol.range instanceof vscode.Range) || !symbol.range.contains(position)) {
      continue;
    }
    const deeper = findInnermostSymbol(symbol.children, position);
    // Some providers emit the accessor itself as a nested symbol; naming the
    // tab after it would produce labels like "get.get", so prefer its parent.
    if (deeper && !ACCESSOR_WORDS.has(deeper.name)) {
      return deeper;
    }
    return ACCESSOR_WORDS.has(symbol.name) ? undefined : symbol;
  }
  return undefined;
}

/**
 * Re-executes `search` from its stored origin location (`originUri` /
 * `originLine`), producing a fresh {@link Search} that keeps the original
 * `id` and `createdAt` (so it replaces the existing tab in place) but has
 * up-to-date `groups` / `totalCount`.
 *
 * The exact origin position isn't stored (only the line), so this looks up
 * the stored raw `word` (not the possibly-composed `symbol` label) on that
 * line and re-resolves a word range there. Returns `undefined` (after
 * showing a warning) if the origin document can't be opened, or the word
 * text is no longer found on that line — in both cases the caller should
 * keep the existing tab's results untouched.
 */
export async function rerunSearch(search: Search): Promise<Search | undefined> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.parse(search.originUri));
  } catch {
    void vscode.window.showWarningMessage(
      `Reference Tabs: could not reopen the origin file for '${search.symbol}'.`
    );
    return undefined;
  }

  if (search.originLine < 0 || search.originLine >= document.lineCount) {
    void vscode.window.showWarningMessage(
      `Reference Tabs: '${search.symbol}' is no longer at its original location.`
    );
    return undefined;
  }

  const lineText = document.lineAt(search.originLine).text;
  const symbolIndex = lineText.indexOf(search.word);
  if (symbolIndex === -1) {
    void vscode.window.showWarningMessage(
      `Reference Tabs: '${search.symbol}' is no longer at its original location.`
    );
    return undefined;
  }

  const position = new vscode.Position(search.originLine, symbolIndex);
  const wordRange = document.getWordRangeAtPosition(position);
  if (!wordRange) {
    void vscode.window.showWarningMessage(
      `Reference Tabs: '${search.symbol}' is no longer at its original location.`
    );
    return undefined;
  }

  const command =
    search.kind === "references"
      ? "vscode.executeReferenceProvider"
      : "vscode.executeImplementationProvider";

  const raw = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[] | undefined
  >(command, document.uri, wordRange.start);

  const normalized = normalizeLocations(raw ?? []);

  if (normalized.length === 0) {
    const kindLabel = search.kind === "references" ? "references" : "implementations";
    void vscode.window.showInformationMessage(
      `Reference Tabs: no ${kindLabel} found for '${search.symbol}'.`
    );
    return undefined;
  }

  const groups = await buildGroups(normalized);
  const totalCount = groups.reduce((sum, group) => sum + group.items.length, 0);

  return {
    ...search,
    groups,
    totalCount,
  };
}

/** `vscode.executeImplementationProvider` may return `LocationLink[]`; flatten both shapes to `{ uri, range }`. */
function normalizeLocations(
  raw: readonly (vscode.Location | vscode.LocationLink)[]
): NormalizedLocation[] {
  return raw.map((item) => {
    if (isLocationLink(item)) {
      return { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange };
    }
    return { uri: item.uri, range: item.range };
  });
}

function isLocationLink(
  item: vscode.Location | vscode.LocationLink
): item is vscode.LocationLink {
  return (item as vscode.LocationLink).targetUri !== undefined;
}

/** Groups normalized locations by file, sorted by relative path; items within a group sorted by position. */
async function buildGroups(locations: NormalizedLocation[]): Promise<FileGroup[]> {
  const byUri = new Map<string, { uri: vscode.Uri; ranges: vscode.Range[] }>();
  for (const loc of locations) {
    const key = loc.uri.toString();
    const entry = byUri.get(key);
    if (entry) {
      entry.ranges.push(loc.range);
    } else {
      byUri.set(key, { uri: loc.uri, ranges: [loc.range] });
    }
  }

  const groups: FileGroup[] = [];
  for (const { uri, ranges } of byUri.values()) {
    ranges.sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character);

    // Open the document once per file and cache one lookup per distinct line.
    let lineTextByLine: Map<number, string> | undefined;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      lineTextByLine = new Map();
      for (const range of ranges) {
        if (!lineTextByLine.has(range.start.line)) {
          lineTextByLine.set(range.start.line, doc.lineAt(range.start.line).text);
        }
      }
    } catch {
      // File may be unreadable (deleted, binary, etc.) — fall back to empty previews.
      lineTextByLine = undefined;
    }

    const items: SearchResultItem[] = ranges.map((range) => buildItem(range, lineTextByLine));

    groups.push({
      uri: uri.toString(),
      relativePath: vscode.workspace.asRelativePath(uri),
      items,
      collapsed: false,
    });
  }

  groups.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return groups;
}

/** Trims the source line, caps it at {@link MAX_LINE_LENGTH}, and shifts the match offsets to match. */
function buildItem(
  range: vscode.Range,
  lineTextByLine: Map<number, string> | undefined
): SearchResultItem {
  const fullLine = lineTextByLine?.get(range.start.line) ?? "";
  const leadingTrimLen = fullLine.length - fullLine.trimStart().length;
  const trimmed = fullLine.trim();
  const capped = trimmed.length > MAX_LINE_LENGTH ? trimmed.slice(0, MAX_LINE_LENGTH) : trimmed;

  const character = clamp(range.start.character - leadingTrimLen, 0, capped.length);
  const endCharacter = clamp(range.end.character - leadingTrimLen, 0, capped.length);

  return {
    line: range.start.line,
    character,
    endCharacter,
    lineText: capped,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
