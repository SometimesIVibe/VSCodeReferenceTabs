/**
 * JSON-serializable data model for a single "Find All References" /
 * "Find All Implementations" search and its results.
 *
 * Kept free of `vscode.*` types so a `Search` can be persisted to disk
 * (Step 4) and restored without depending on live editor state.
 */

export type SearchKind = "references" | "implementations" | "callHierarchy";

/** Plain, JSON-serializable range (start/end line+character), used by call-hierarchy nodes so they need no live `vscode.Range`. */
export interface PlainRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/**
 * One node in an incoming-call hierarchy tree (a *caller* of its parent).
 * Fully JSON-serializable: it keeps enough of the underlying
 * `vscode.CallHierarchyItem` (`symbolKind` + `range` + `selectionRange` +
 * `uri`) to reconstruct that item on demand and lazily fetch this node's own
 * callers (see `callHierarchy.ts`), so the whole tree round-trips through the
 * webview and the store like any other search data.
 */
export interface CallNode {
  /** Stable id within its tree — UI identity and lazy-expand targeting. */
  id: string;
  /** Caller symbol name. */
  name: string;
  /** Provider-supplied detail (containing type/namespace); may be empty. */
  detail: string;
  /** `vscode.SymbolKind` numeric value, kept to reconstruct the CallHierarchyItem. */
  symbolKind: number;
  /** `vscode.Uri.toString()` of the caller's file. */
  uri: string;
  /** Full range of the caller item. */
  range: PlainRange;
  /** Name/selection range — where clicking the node navigates. */
  selectionRange: PlainRange;
  /** The caller's file is in a .NET test project (this node's own status). */
  isTest: boolean;
  /**
   * Rolled-up test status: true when this node and every caller loaded
   * beneath it are test-only. Falls back to `isTest` while unexpanded. Test
   * branches sort to the bottom of their level and render dimmed.
   */
  branchTest: boolean;
  /** Whether this node's callers have been fetched yet (lazy expansion). */
  loaded: boolean;
  /** UI expand state. */
  expanded: boolean;
  /** Caller nodes (incoming calls into this one). */
  children: CallNode[];
}

/** A single match within a file, ready for display. */
export interface SearchResultItem {
  /** 0-based line number in the target file. */
  line: number;
  /** 0-based start column of the match, relative to the (trimmed) lineText. */
  character: number;
  /** 0-based end column of the match, relative to the (trimmed) lineText. */
  endCharacter: number;
  /** Trimmed, length-capped preview of the source line. */
  lineText: string;
}

/** All matches within a single file. */
export interface FileGroup {
  /** `vscode.Uri.toString()` of the file. */
  uri: string;
  /** Workspace-relative path for display, via `vscode.workspace.asRelativePath`. */
  relativePath: string;
  /** Matches in this file, sorted by line. */
  items: SearchResultItem[];
  /** UI collapse state (Step 3 toggles this; defaults to expanded). */
  collapsed: boolean;
  /**
   * Whether this file belongs to a .NET test project, decided by locating
   * the nearest enclosing `.csproj` and parsing it (see
   * `TestProjectClassifier`). Test groups sort below the non-test groups and
   * render with a "test" badge. Derived at search time;
   * searches persisted before this field predate it, so their groups load
   * without it (rendered as non-test) until the search is re-run.
   */
  isTest: boolean;
}

/**
 * A section of a call-hierarchy search when the searched symbol is an
 * interface member: one group for the interface itself and one per
 * implementing class. Each holds its own incoming-call tree, lazily expanded
 * like any {@link CallNode}. Rendered under a collapsible header.
 */
export interface CallGroup {
  /** Stable id — UI identity and collapse targeting. */
  id: string;
  /** Header label: the interface type name, or the implementing class name. */
  title: string;
  /** Whether this group is the interface itself (shown first) or an implementation. */
  kind: "interface" | "implementation";
  /** Direct callers of this group's member; each node's callers load lazily. */
  roots: CallNode[];
  /**
   * Whether every direct caller in this group is test-only, computed once at
   * creation from the initial roots — used to order test-only groups to the
   * bottom and to pre-collapse them. The rendered "test" badge is derived
   * live from `roots` so it stays accurate as nodes expand.
   */
  isTest: boolean;
  /** UI collapse state; pre-collapsed when the group is test-only at creation. */
  collapsed: boolean;
}

/** One completed search, grouped by file. */
export interface Search {
  /** Stable unique id, `crypto.randomUUID()`. */
  id: string;
  kind: SearchKind;
  /**
   * Display label shown in tabs and the badge tooltip. Usually equal to
   * `word`, but for an accessor keyword (`get`/`set`/`init`/`add`/`remove`)
   * it is composed as `${enclosingSymbolName}.${word}` (e.g. `Name.get`).
   */
  symbol: string;
  /**
   * Raw token under the cursor when the search was triggered, used by
   * `rerunSearch` to relocate the position on the origin line. `symbol` may
   * differ from this (accessor searches); non-accessor searches have
   * `symbol === word`.
   */
  word: string;
  /** `vscode.Uri.toString()` of the document the search originated from. */
  originUri: string;
  /** 0-based line the cursor was on when the search was triggered. */
  originLine: number;
  /** Epoch ms. */
  createdAt: number;
  /** Results grouped by file, sorted by `relativePath`. Empty for `callHierarchy` searches. */
  groups: FileGroup[];
  /**
   * Incoming-call tree for `kind === "callHierarchy"` — the top-level entries
   * are the direct callers of the searched symbol; each node's `children` are
   * lazily filled in on expand. `undefined`/absent for reference and
   * implementation searches (which use `groups`).
   */
  callTree?: CallNode[];
  /**
   * Grouped incoming-call trees for a `callHierarchy` search whose target is
   * an **interface** member: the interface's own callers plus one group per
   * implementing class (see {@link CallGroup}). Present instead of
   * `callTree` in that case; absent for a search on a concrete/plain symbol,
   * which uses the flat `callTree`.
   */
  callGroups?: CallGroup[];
  /** Sum of `items.length` across all groups, or the number of direct callers for a call-hierarchy search. */
  totalCount: number;
  /**
   * Whether this tab is pinned. Pinned tabs sort leftmost, are exempt from
   * `maxSearches` eviction, and survive "Close All Tabs (Keep Pinned)".
   * Persisted files from ≤0.2.2 predate this field; `persistence.loadAll`
   * defaults it to `false` on load (same pattern as `word`).
   */
  pinned: boolean;
  /**
   * Deterministic identity for dedup, distinct from `id` (a fresh GUID every
   * run). Computed in `runSearch` from the resolved definition location of
   * the search target: `${kind}|${defUri}|${line}:${char}|${symbol}` (falls
   * back to `${kind}|fallback|${originUri}|${originLine}|${word}` when no
   * definition is found). `SearchStore.add` uses it to reuse an existing tab
   * — same key in, same tab reloaded in place — instead of opening a
   * duplicate. `rerunSearch` keeps the original search's `key`. Persisted
   * files from ≤0.3.0 predate this field; `persistence.loadAll` defaults it
   * to `"legacy:" + id` (unique per file, so old tabs never falsely dedup
   * against each other or a fresh search).
   */
  key: string;
}
