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

  /**
   * Removes a search (closes its tab). If it was the active tab, activates
   * a neighbor (preferring the one that took its place, falling back to the
   * new last tab). If no searches remain, `activeId` becomes `undefined`.
   */
  public close(id: string): void {
    const index = this.searches.findIndex((search) => search.id === id);
    if (index === -1) {
      return;
    }

    this.searches.splice(index, 1);

    if (this.activeSearchId === id) {
      const neighborIndex = Math.min(index, this.searches.length - 1);
      this.activeSearchId = neighborIndex >= 0 ? this.searches[neighborIndex].id : undefined;
    }

    this._onDidChange.fire();
  }

  /** Makes the given search the active tab. No-op if `id` is unknown. */
  public setActive(id: string): void {
    if (this.activeSearchId === id) {
      return;
    }
    if (!this.searches.some((search) => search.id === id)) {
      return;
    }
    this.activeSearchId = id;
    this._onDidChange.fire();
  }

  /** Sets the collapse state of a single file group within a search. */
  public toggleGroup(id: string, uri: string, collapsed: boolean): void {
    const search = this.searches.find((s) => s.id === id);
    const group = search?.groups.find((g) => g.uri === uri);
    if (!group || group.collapsed === collapsed) {
      return;
    }
    group.collapsed = collapsed;
    this._onDidChange.fire();
  }

  /** Sets the collapse state of every file group within a search (expand-all / collapse-all). */
  public setAllGroups(id: string, collapsed: boolean): void {
    const search = this.searches.find((s) => s.id === id);
    if (!search) {
      return;
    }
    let changed = false;
    for (const group of search.groups) {
      if (group.collapsed !== collapsed) {
        group.collapsed = collapsed;
        changed = true;
      }
    }
    if (changed) {
      this._onDidChange.fire();
    }
  }

  public dispose(): void {
    this._onDidChange.dispose();
  }
}
