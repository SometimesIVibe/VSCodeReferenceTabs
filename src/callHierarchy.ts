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
import { CallNode, PlainRange, Search } from "./model";
import { TestProjectClassifier } from "./testProject";
import { recomputeAndSort } from "./callTree";

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

  const roots = await incomingCallsFor(root);
  if (roots.length === 0) {
    void vscode.window.showInformationMessage(
      `Reference Tabs: no callers found for '${root.name}'.`
    );
    return undefined;
  }

  recomputeAndSort(roots);

  return {
    id: randomUUID(),
    kind: "callHierarchy",
    symbol: root.name,
    word: root.name,
    originUri: document.uri.toString(),
    originLine: position.line,
    createdAt: Date.now(),
    groups: [],
    callTree: roots,
    totalCount: roots.length,
    pinned: false,
    key: `callHierarchy|${root.uri.toString()}|${root.selectionRange.start.line}:${root.selectionRange.start.character}|${root.name}`,
  };
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
