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
  /** Word at the cursor when the search was triggered. */
  symbol: string;
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
}
