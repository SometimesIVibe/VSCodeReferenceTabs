/**
 * Incoming call-hierarchy queries, adapting VS Code's call-hierarchy provider
 * into the JSON-serializable {@link CallNode} tree the store and webview use.
 *
 * A search's top-level nodes are the direct callers of the symbol under the
 * cursor; each node's own callers are fetched lazily on expand
 * ({@link incomingCallsFor}). Every node is classified test/non-test by the
 * shared {@link TestProjectClassifier}; the roll-up and ordering live in
 * `callTree.ts`.
 */
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { CallGroup, CallNode, PlainRange, Search } from "./model";
import { TestProjectClassifier } from "./testProject";
import { allRootsTest, orderCallGroups, recomputeAndSort } from "./callTree";

// One classifier for the whole session: .csproj verdicts are effectively
// stable within a session, so caching across every prepare/expand is safe and
// keeps repeated expansions cheap.
const classifier = new TestProjectClassifier();

/**
 * Prepares an incoming call hierarchy for the symbol at the editor cursor and
 * returns a ready-to-store {@link Search}, or `undefined` (with a user-facing
 * message) when there is no call-hierarchy symbol or it has no callers.
 */
export async function prepareIncomingCallHierarchy(
  editor: vscode.TextEditor
): Promise<Search | undefined> {
  const document = editor.document;
  const position = editor.selection.active;

  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
    "vscode.prepareCallHierarchy",
    document.uri,
    position
  );
  const root = items?.[0];
  if (!root) {
    void vscode.window.showWarningMessage(
      "Reference Tabs: no caller-hierarchy symbol at the cursor."
    );
    return undefined;
  }

  const base = {
    id: randomUUID(),
    kind: "callHierarchy" as const,
    symbol: root.name,
    word: root.name,
    originUri: document.uri.toString(),
    originLine: position.line,
    createdAt: Date.now(),
    groups: [],
    pinned: false,
    accessAware: false,
    accessFilter: "none" as const,
    key: `callHierarchy|${root.uri.toString()}|${root.selectionRange.start.line}:${root.selectionRange.start.character}|${root.name}`,
  };

  // If the target is an interface member, split the results into the
  // interface's own callers plus a group per implementing class.
  const callGroups = await buildInterfaceGroups(root, document.uri, position);
  if (callGroups) {
    if (callGroups.every((group) => group.roots.length === 0)) {
      void vscode.window.showInformationMessage(
        `Reference Tabs: no callers found for '${root.name}' or its implementations.`
      );
      return undefined;
    }
    const totalCount = callGroups.reduce((sum, group) => sum + group.roots.length, 0);
    return { ...base, callGroups, totalCount };
  }

  // Plain (concrete/standalone) symbol: a single flat caller tree.
  const roots = await incomingCallsFor(root);
  if (roots.length === 0) {
    void vscode.window.showInformationMessage(
      `Reference Tabs: no callers found for '${root.name}'.`
    );
    return undefined;
  }
  recomputeAndSort(roots);
  return { ...base, callTree: roots, totalCount: roots.length };
}

/**
 * When `root` is an **interface** member, returns the grouped caller trees:
 * the interface's own callers first, then one group per implementing class
 * (found via the implementation provider). Returns `undefined` when the
 * symbol is not an interface member, signalling the flat single-tree path.
 */
async function buildInterfaceGroups(
  root: vscode.CallHierarchyItem,
  uri: vscode.Uri,
  position: vscode.Position
): Promise<CallGroup[] | undefined> {
  const enclosing = await enclosingType(root.uri, root.selectionRange.start);
  if (enclosing?.kind !== vscode.SymbolKind.Interface) {
    return undefined;
  }

  const groups: CallGroup[] = [makeGroup(enclosing.name, "interface", await incomingCallsFor(root))];

  const seen = new Set<string>([locationKey(root.uri, root.selectionRange.start)]);
  const implementations = normalizeLocations(
    await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
      "vscode.executeImplementationProvider",
      uri,
      position
    )
  );
  for (const impl of implementations) {
    const key = locationKey(impl.uri, impl.range.start);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const implItem = (
      await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
        "vscode.prepareCallHierarchy",
        impl.uri,
        impl.range.start
      )
    )?.[0];
    if (!implItem) {
      continue;
    }
    const type = await enclosingType(impl.uri, impl.range.start);
    const title = type?.name ?? (implItem.detail || implItem.name);
    groups.push(makeGroup(title, "implementation", await incomingCallsFor(implItem)));
  }

  orderCallGroups(groups);
  return groups;
}

/** Builds a group, rolling up + sorting its roots and pre-collapsing it when all its callers are test. */
function makeGroup(title: string, kind: CallGroup["kind"], roots: CallNode[]): CallGroup {
  recomputeAndSort(roots);
  const isTest = allRootsTest(roots);
  return { id: randomUUID(), title, kind, roots, isTest, collapsed: isTest };
}

/**
 * Fetches the incoming callers of a call-hierarchy item as fresh, unexpanded
 * {@link CallNode}s. Accepts either a live `vscode.CallHierarchyItem` (the
 * prepared root) or a stored {@link CallNode} (a lazy expand).
 *
 * For a stored node we re-run `prepareCallHierarchy` at the node's own
 * location to obtain a *provider-native* item rather than reconstructing one
 * from saved primitives: language servers (C#, TS, …) attach hidden
 * provider-internal state to their items (the LSP `data` field, round-tripped
 * between prepare and incoming/outgoing calls), which a reconstructed item
 * lacks — without it the server resolves few or no callers. This mirrors how
 * VS Code's built-in view keeps native items. `reconstructItem` remains a
 * last-resort fallback when prepare yields nothing.
 */
export async function incomingCallsFor(
  target: vscode.CallHierarchyItem | CallNode
): Promise<CallNode[]> {
  const item =
    target instanceof vscode.CallHierarchyItem
      ? target
      : (await resolveNativeItem(target)) ?? reconstructItem(target);

  const calls = await vscode.commands.executeCommand<
    vscode.CallHierarchyIncomingCall[] | undefined
  >("vscode.provideIncomingCalls", item);

  const nodes: CallNode[] = [];
  for (const call of calls ?? []) {
    const from = call.from;
    const isTest = await classifier.isTestReference(from.uri);
    nodes.push({
      id: randomUUID(),
      name: from.name,
      detail: from.detail ?? "",
      symbolKind: from.kind,
      uri: from.uri.toString(),
      range: toPlainRange(from.range),
      selectionRange: toPlainRange(from.selectionRange),
      isTest,
      branchTest: isTest,
      loaded: false,
      expanded: false,
      children: [],
    });
  }
  return nodes;
}

/**
 * Re-prepares a provider-native `CallHierarchyItem` for a stored node by
 * running `prepareCallHierarchy` at the node's selection-range start, matching
 * the returned item by name (falling back to the first). Returns `undefined`
 * when prepare yields nothing, so the caller can fall back to reconstruction.
 */
async function resolveNativeItem(node: CallNode): Promise<vscode.CallHierarchyItem | undefined> {
  const uri = vscode.Uri.parse(node.uri);
  const position = new vscode.Position(
    node.selectionRange.startLine,
    node.selectionRange.startCharacter
  );
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
    "vscode.prepareCallHierarchy",
    uri,
    position
  );
  if (!items || items.length === 0) {
    return undefined;
  }
  return items.find((item) => item.name === node.name) ?? items[0];
}

function reconstructItem(node: CallNode): vscode.CallHierarchyItem {
  return new vscode.CallHierarchyItem(
    node.symbolKind,
    node.name,
    node.detail,
    vscode.Uri.parse(node.uri),
    toRange(node.range),
    toRange(node.selectionRange)
  );
}

function toPlainRange(range: vscode.Range): PlainRange {
  return {
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

function toRange(range: PlainRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.startLine, range.startCharacter),
    new vscode.Position(range.endLine, range.endCharacter)
  );
}

/**
 * The innermost enclosing type (class/interface/struct/…) symbol at
 * `position` in `uri`, via the document-symbol provider. Used both to decide
 * whether the searched member lives on an interface and to name an
 * implementation group after its declaring class.
 */
async function enclosingType(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<vscode.DocumentSymbol | undefined> {
  const symbols = await vscode.commands.executeCommand<
    (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
  >("vscode.executeDocumentSymbolProvider", uri);
  return innermostType((symbols ?? []).filter(isDocumentSymbol), position);
}

const TYPE_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Object,
]);

function innermostType(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (!symbol.range.contains(position)) {
      continue;
    }
    const nested = innermostType(symbol.children, position);
    if (nested) {
      return nested;
    }
    if (TYPE_KINDS.has(symbol.kind)) {
      return symbol;
    }
  }
  return undefined;
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return Array.isArray((symbol as vscode.DocumentSymbol).children);
}

/** Flattens `Location[] | LocationLink[]` from a provider to `{ uri, range }` pairs (target range for links). */
function normalizeLocations(
  raw: (vscode.Location | vscode.LocationLink)[] | undefined
): { uri: vscode.Uri; range: vscode.Range }[] {
  return (raw ?? []).map((item) =>
    "targetUri" in item
      ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange }
      : { uri: item.uri, range: item.range }
  );
}

function locationKey(uri: vscode.Uri, position: vscode.Position): string {
  return `${uri.toString()}:${position.line}:${position.character}`;
}
