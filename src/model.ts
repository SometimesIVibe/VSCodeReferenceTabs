/**
 * JSON-serializable data model for a single "Find All References" /
 * "Find All Implementations" search and its results.
 *
 * Kept free of `vscode.*` types so a `Search` can be persisted to disk
 * (Step 4) and restored without depending on live editor state.
 */

export type SearchKind = "references" | "implementations";

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
  /** Results grouped by file, sorted by `relativePath`. */
  groups: FileGroup[];
  /** Sum of `items.length` across all groups. */
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
