import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { EnclosingKind, SearchLabelBuilder } from "./labels";
import { TestProjectClassifier } from "./testProject";
import { FileGroup, Search, SearchKind, SearchResultItem } from "./model";

/** Preview lines are trimmed then capped to this many characters. */
const MAX_LINE_LENGTH = 200;

/**
 * Raw cursor tokens that get an enclosing-symbol prefix in the display
 * label (C# property/indexer/event accessors). Any language: false
 * positives just produce a slightly-too-rich label, never a wrong search.
 */
const ACCESSOR_WORDS = new Set(["get", "set", "init", "add", "remove"]);

/** Shared instance: {@link SearchLabelBuilder} is stateless and pure. */
const labelBuilder = new SearchLabelBuilder();

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
  const symbol = await composeLabel(document, wordRange, word);
  const key = await computeKey(kind, document, position, symbol, word);

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

  const accessAware = kind === "references" && (await isAccessAwareTarget(document, position));
  const groups = await buildGroups(normalized, accessAware, {
    uri: document.uri.toString(),
    position: wordRange.start,
  });
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
    pinned: false,
    key,
    accessAware,
    // Default; SearchStore.add seeds a new tab from the remembered last filter
    // and a re-searched/re-run tab keeps its existing one.
    accessFilter: "none",
  };
}

/** `vscode.SymbolKind`s whose references are meaningfully read vs written (so the Read/Write filter applies). */
const ACCESS_AWARE_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Field,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Event,
  vscode.SymbolKind.EnumMember,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Variable,
]);

/** True when the definition of the symbol under the cursor is a field/property/event/… (a value that is read and written). */
async function isAccessAwareTarget(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<boolean> {
  const def = normalizeLocations(
    (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
      "vscode.executeDefinitionProvider",
      document.uri,
      position
    )) ?? []
  )[0];
  if (!def) {
    return false;
  }
  let symbols: vscode.DocumentSymbol[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      "vscode.executeDocumentSymbolProvider",
      def.uri
    );
  } catch {
    return false;
  }
  const symbol = findInnermostSymbol(symbols, def.range.start);
  return symbol ? ACCESS_AWARE_KINDS.has(symbol.kind) : false;
}

/**
 * Classifies each range in a file as a read or write via the
 * document-highlight provider (which tags occurrences `Read`/`Write`/`Text`).
 * Keyed by `"line:character"` of the range start; ranges the provider doesn't
 * cover (or when it's unavailable) default to `"read"`.
 */
async function classifyAccess(
  uri: vscode.Uri,
  ranges: vscode.Range[]
): Promise<Map<string, "read" | "write">> {
  const result = new Map<string, "read" | "write">();
  let highlights: vscode.DocumentHighlight[] | undefined;
  try {
    highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[] | undefined>(
      "vscode.executeDocumentHighlights",
      uri,
      ranges[0].start
    );
  } catch {
    highlights = undefined;
  }
  for (const range of ranges) {
    const hit = highlights?.find((h) => h.range.contains(range.start));
    const access = hit?.kind === vscode.DocumentHighlightKind.Write ? "write" : "read";
    result.set(`${range.start.line}:${range.start.character}`, access);
  }
  return result;
}

/**
 * Computes the deterministic dedup key for a search target: resolves the
 * primary definition of the symbol under the cursor via
 * `vscode.executeDefinitionProvider` and combines it with `kind` and the
 * already-composed display `label` — `${kind}|${defUri}|${line}:${char}|${label}`.
 * The label is part of the key (not just the definition location) so that,
 * e.g., a `new Foo()` constructor call and a plain `Foo` type reference never
 * collide even when TypeScript resolves both to the same class declaration
 * (see the search.test.ts case for this exact scenario), and so C# records
 * (primary constructor === record declaration) separate the two naturally.
 *
 * Falls back to `${kind}|fallback|${originUri}|${originLine}|${word}` when
 * the provider is missing, returns no results, or throws — this still
 * uniquely identifies the origin of the search, just not the target symbol's
 * canonical definition.
 */
async function computeKey(
  kind: SearchKind,
  document: vscode.TextDocument,
  position: vscode.Position,
  label: string,
  word: string
): Promise<string> {
  const originUri = document.uri.toString();
  const originLine = position.line;
  const fallback = `${kind}|fallback|${originUri}|${originLine}|${word}`;

  try {
    const raw = await vscode.commands.executeCommand<
      (vscode.Location | vscode.LocationLink)[] | undefined
    >("vscode.executeDefinitionProvider", document.uri, position);

    const normalized = normalizeLocations(raw ?? []);
    const primary = normalized[0];
    if (!primary) {
      return fallback;
    }

    const defUri = primary.uri.toString();
    const { line, character } = primary.range.start;
    return `${kind}|${defUri}|${line}:${character}|${label}`;
  } catch {
    return fallback;
  }
}

/**
 * Composes the display label for the cursor word by adapting live editor /
 * document-symbol data into plain {@link LabelInput} and delegating the
 * actual rules to {@link SearchLabelBuilder} (`src/labels.ts`, dependency-free
 * and unit-tested on its own). Always fetches document symbols (cheap; the
 * language server caches them) so both the accessor-label rule and the
 * constructor-declaration rule have an `enclosing` symbol to work with, but
 * tolerates the provider being absent/failing/returning `SymbolInformation[]`
 * (no `.children`/nested ranges) by falling back to `enclosing: undefined`.
 */
async function composeLabel(
  document: vscode.TextDocument,
  wordRange: vscode.Range,
  word: string
): Promise<string> {
  let root: vscode.DocumentSymbol[] | undefined;
  try {
    root = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      "vscode.executeDocumentSymbolProvider",
      document.uri
    );
  } catch {
    root = undefined;
  }

  const innermost = findInnermostSymbol(root, wordRange.start);
  const enclosing = innermost
    ? { name: innermost.name, kind: mapSymbolKind(innermost.kind) }
    : undefined;

  const lineText = document.lineAt(wordRange.start.line).text;
  const lineTextBeforeWord = lineText.slice(0, wordRange.start.character);
  const wordFollowedByOpenParen = lineText.slice(wordRange.end.character).trimStart().startsWith("(");
  const enclosingTypeName = findEnclosingTypeName(root, wordRange.start);

  return labelBuilder.build({
    word,
    lineTextBeforeWord,
    enclosing,
    enclosingTypeName,
    wordFollowedByOpenParen,
  });
}

/** Names of the `vscode.SymbolKind`s treated as an enclosing "type" for constructor detection. */
const TYPE_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Object,
]);

/** Name of the innermost enclosing type symbol (class/struct/record/interface/…) containing `position`, or `undefined`. */
function findEnclosingTypeName(
  symbols: vscode.DocumentSymbol[] | undefined,
  position: vscode.Position
): string | undefined {
  if (!Array.isArray(symbols)) {
    return undefined;
  }
  for (const symbol of symbols) {
    if (!symbol || !(symbol.range instanceof vscode.Range) || !symbol.range.contains(position)) {
      continue;
    }
    const nested = findEnclosingTypeName(symbol.children, position);
    if (nested !== undefined) {
      return nested;
    }
    if (TYPE_SYMBOL_KINDS.has(symbol.kind)) {
      return symbol.name;
    }
  }
  return undefined;
}

/** Collapses `vscode.SymbolKind` down to the small string union the pure {@link SearchLabelBuilder} understands. */
function mapSymbolKind(kind: vscode.SymbolKind): EnclosingKind {
  switch (kind) {
    case vscode.SymbolKind.Constructor:
      return "constructor";
    case vscode.SymbolKind.Property:
      return "property";
    default:
      return "other";
  }
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

  const groups = await buildGroups(normalized, search.accessAware, {
    uri: document.uri.toString(),
    position: wordRange.start,
  });
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

/** Groups normalized locations by file, sorted by relative path; items within a group sorted by position. Classifies each item read/write when `accessAware`, and marks the origin occurrence. */
async function buildGroups(
  locations: NormalizedLocation[],
  accessAware: boolean,
  origin?: { uri: string; position: vscode.Position }
): Promise<FileGroup[]> {
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

  const classifier = new TestProjectClassifier();
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

    const access = accessAware ? await classifyAccess(uri, ranges) : undefined;
    const isOriginFile = origin !== undefined && uri.toString() === origin.uri;
    const items: SearchResultItem[] = ranges.map((range) => {
      const item = buildItem(range, lineTextByLine, access?.get(`${range.start.line}:${range.start.character}`));
      if (isOriginFile && origin && rangeCoversPosition(range, origin.position)) {
        item.origin = true;
      }
      return item;
    });

    const relativePath = vscode.workspace.asRelativePath(uri);
    const isTest = await classifier.isTestReference(uri);
    const accessKind = accessAware ? groupAccessKind(items) : undefined;
    groups.push({
      uri: uri.toString(),
      relativePath,
      items,
      // Test groups and homogeneous read-only / write-only groups start
      // collapsed, so the non-test and the mixed read/write groups — the ones
      // worth reading — are what you see first.
      collapsed: isTest || accessKind === "read" || accessKind === "write",
      isTest,
      ...(accessKind ? { accessKind } : {}),
    });
  }

  // Non-test groups first, test groups below — each block sorted alphabetically
  // by relative path.
  groups.sort(
    (a, b) =>
      Number(a.isTest) - Number(b.isTest) || a.relativePath.localeCompare(b.relativePath)
  );
  return groups;
}

/** True when `position` falls within `range` on its start line (identifier ranges are single-line) — used to find the origin occurrence. */
function rangeCoversPosition(range: vscode.Range, position: vscode.Position): boolean {
  return (
    position.line === range.start.line &&
    position.character >= range.start.character &&
    position.character <= range.end.character
  );
}

/** Whether a group's classified items are all reads, all writes, or a mix; `undefined` when none are classified. */
function groupAccessKind(
  items: SearchResultItem[]
): "read" | "write" | "mixed" | undefined {
  let hasRead = false;
  let hasWrite = false;
  for (const item of items) {
    if (item.access === "read") {
      hasRead = true;
    } else if (item.access === "write") {
      hasWrite = true;
    }
  }
  if (hasRead && hasWrite) {
    return "mixed";
  }
  if (hasRead) {
    return "read";
  }
  if (hasWrite) {
    return "write";
  }
  return undefined;
}

/** Trims the source line, caps it at {@link MAX_LINE_LENGTH}, and shifts the match offsets to match. */
function buildItem(
  range: vscode.Range,
  lineTextByLine: Map<number, string> | undefined,
  access: "read" | "write" | undefined
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
    ...(access ? { access } : {}),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
