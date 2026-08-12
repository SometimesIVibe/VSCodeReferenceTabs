import * as vscode from "vscode";
import { Search } from "./model";

/**
 * In-memory collection of completed searches ("tabs").
 *
 * This is the single write path for search data: the panel provider (and,
 * from Step 4 onward, the persistence layer) only ever reacts to
 * `onDidChange` and reads `all` / `activeId` — they never mutate a `Search`
 * directly.
 */
export class SearchStore implements vscode.Disposable {
  private readonly searches: Search[] = [];
  private activeSearchId: string | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  /** All searches, oldest first. */
  public get all(): readonly Search[] {
    return this.searches;
  }

  public get activeId(): string | undefined {
    return this.activeSearchId;
  }

  /** Adds a new search and makes it the active one. */
  public add(search: Search): void {
    this.searches.push(search);
    this.activeSearchId = search.id;
    this._onDidChange.fire();
  }

  public dispose(): void {
    this._onDidChange.dispose();
  }
}
