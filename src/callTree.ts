/**
 * Pure, `vscode`-free operations on an incoming-call {@link CallNode} tree:
 * the test-branch roll-up, level ordering, and node lookup. Kept separate
 * from `callHierarchy.ts` (which does the `vscode` provider I/O) so this logic
 * is unit-testable in plain node.
 */
import { CallGroup, CallNode } from "./model";

/**
 * Recomputes every node's rolled-up `branchTest` bottom-up and orders each
 * level, in place.
 *
 * `branchTest` is true when a node and all callers loaded beneath it are
 * test-only:
 *   - an expanded node with children → every child is a test branch;
 *   - otherwise (a leaf, or a not-yet-expanded node) → the node's own
 *     `isTest`.
 * So an unexpanded node shows its own file's status, and a node whose entire
 * loaded caller subtree is test — e.g. a production method only ever called
 * from tests — rolls up to a test branch as you expand it.
 *
 * Ordering matches the flat reference groups: non-test before test at every
 * level, tie-broken by name. Test branches therefore always sit at the bottom.
 */
export function recomputeAndSort(nodes: CallNode[]): void {
  for (const node of nodes) {
    recomputeNode(node);
  }
  sortLevel(nodes);
}

function recomputeNode(node: CallNode): boolean {
  if (node.loaded && node.children.length > 0) {
    let allTest = true;
    for (const child of node.children) {
      if (!recomputeNode(child)) {
        allTest = false;
      }
    }
    node.branchTest = allTest;
    sortLevel(node.children);
  } else {
    node.branchTest = node.isTest;
  }
  return node.branchTest;
}

function sortLevel(nodes: CallNode[]): void {
  nodes.sort(
    (a, b) => Number(a.branchTest) - Number(b.branchTest) || a.name.localeCompare(b.name)
  );
}

/**
 * Orders call-hierarchy groups in place: the interface group first, then the
 * implementation groups with the non-test ones before the test-only ones
 * (matching how test branches sort to the bottom elsewhere), tie-broken by
 * title.
 */
export function orderCallGroups(groups: CallGroup[]): void {
  groups.sort((a, b) => {
    const aInterface = a.kind === "interface" ? 0 : 1;
    const bInterface = b.kind === "interface" ? 0 : 1;
    return (
      aInterface - bInterface ||
      Number(a.isTest) - Number(b.isTest) ||
      a.title.localeCompare(b.title)
    );
  });
}

/** True when a group has direct callers and every one of them is a test branch — used to pre-collapse and order test-only groups. */
export function allRootsTest(roots: CallNode[]): boolean {
  return roots.length > 0 && roots.every((root) => root.branchTest);
}

/**
 * Removes duplicate caller nodes that resolve to the same definition location
 * (file + selection-range start), keeping the first. Used when a concrete
 * method's own callers are merged with the callers of the interface member it
 * implements — the same caller can otherwise appear from both queries.
 */
export function dedupeCallNodesByLocation(nodes: CallNode[]): CallNode[] {
  const seen = new Set<string>();
  const result: CallNode[] = [];
  for (const node of nodes) {
    const key = `${node.uri}:${node.selectionRange.startLine}:${node.selectionRange.startCharacter}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(node);
  }
  return result;
}

/** Depth-first lookup of the node with `id` anywhere in `nodes`; `undefined` if absent. */
export function findCallNode(nodes: CallNode[], id: string): CallNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const found = findCallNode(node.children, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}
