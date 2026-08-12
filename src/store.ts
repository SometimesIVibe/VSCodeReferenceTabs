import * as vscode from "vscode";
import { Search } from "./model";
import { SearchPersistence } from "./persistence";

/** Fallback cap on stored searches (mirrors the `referenceTabs.maxSearches` setting default) used before the setting is read. */
export const DEFAULT_MAX_SEARCHES = 30;

const TAB_ORDER_KEY = "referenceTabs.tabOrder";
const ACTIVE_ID_KEY = "referenceTabs.activeId";

/**
 * In-memory collection of completed searches ("tabs").
 *
 * This is the single write path for search data: the panel provider only
 * ever reacts to `onDidChange` and reads `all` / `activeId` — it never
 * mutates a `Search` directly. Mutations here also drive the persistence
 * layer (per-search JSON files) and `workspaceState` (tab order + active
 * id), so every method that changes shape or order updates both.
 *
 * `persistence` and `workspaceState` are optional so the store stays usable
 * without a real `ExtensionContext` (unit tests, or any future headless
 * path) — when omitted, the store is purely in-memory as before Step 4.
 */
export class SearchStore implements vscode.Disposable {
  private readonly searches: Search[] = [];
  private activeSearchId: string | undefined;
  private maxSearches: number = DEFAULT_MAX_SEARCHES;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly persistence?: SearchPersistence,
    private readonly workspaceState?: vscode.Memento
  ) {}

  /** Sets the cap on stored searches (backed by the `referenceTabs.maxSearches` setting). Evicts immediately if the new cap is lower than the current count. */
  public setMaxSearches(max: number): void {
    this.maxSearches = Math.max(1, Math.trunc(max) || DEFAULT_MAX_SEARCHES);
    const before = this.searches.length;
    this.evictOverflow();
    if (this.searches.length !== before) {
      this.persistTabState();
      this._onDidChange.fire();
    }
  }

  /** All searches, oldest first. */
  public get all(): readonly Search[] {
    return this.searches;
  }

  public get activeId(): string | undefined {
    return this.activeSearchId;
  }

  /** Adds a new search and makes it the active one. Persists immediately and evicts the oldest search past the configured max (see {@link setMaxSearches}). */
  public add(search: Search): void {
    this.searches.push(search);
    this.activeSearchId = search.id;

    void this.persistence?.saveSearch(search);
    this.evictOverflow();

    this.persistTabState();
    this._onDidChange.fire();
  }

  /**
   * Replaces the search with the same `id` as `search` in place (same tab
   * position), swapping in fresh groups/counts. Used by the rerun command.
   * No-op if no search with that id exists. Persists and notifies.
   */
  public replace(search: Search): void {
    const index = this.searches.findIndex((s) => s.id === search.id);
    if (index === -1) {
      return;
    }
    this.searches[index] = search;
    void this.persistence?.saveSearch(search);
    this._onDidChange.fire();
  }

  /** Closes every tab and deletes all persisted search files. */
  public clearAll(): void {
    if (this.searches.length === 0) {
      return;
    }
    const ids = this.searches.map((s) => s.id);
    this.searches.length = 0;
    this.activeSearchId = undefined;

    for (const id of ids) {
      void this.persistence?.deleteSearch(id);
    }

    this.persistTabState();
    this._onDidChange.fire();
  }

  /**
   * Removes a search (closes its tab). If it was the active tab, activates
   * a neighbor (preferring the one that took its place, falling back to the
   * new last tab). If no searches remain, `activeId` becomes `undefined`.
   * Deletes the search's persisted file.
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

    void this.persistence?.deleteSearch(id);
    this.persistTabState();
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
    this.persistTabState();
    this._onDidChange.fire();
  }

  /** Sets the collapse state of a single file group within a search. Debounce-persists the change. */
  public toggleGroup(id: string, uri: string, collapsed: boolean): void {
    const search = this.searches.find((s) => s.id === id);
    const group = search?.groups.find((g) => g.uri === uri);
    if (!search || !group || group.collapsed === collapsed) {
      return;
    }
    group.collapsed = collapsed;
    this.persistence?.scheduleSave(search);
    this._onDidChange.fire();
  }

  /** Sets the collapse state of every file group within a search (expand-all / collapse-all). Debounce-persists the change. */
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
      this.persistence?.scheduleSave(search);
      this._onDidChange.fire();
    }
  }

  /**
   * Seeds the store with restored searches and an active id, without
   * writing anything back to disk (the data already came from disk). Used
   * once, on activation, by the fire-and-forget restore in `extension.ts`.
   *
   * Restored searches are prepended, so any search already added by a user
   * command while the restore was in flight is kept and stays active.
   */
  public seed(searches: readonly Search[], activeId: string | undefined): void {
    if (searches.length === 0) {
      return;
    }

    const existingIds = new Set(this.searches.map((s) => s.id));
    const toPrepend = searches.filter((s) => !existingIds.has(s.id));
    this.searches.unshift(...toPrepend);

    if (this.activeSearchId === undefined) {
      this.activeSearchId =
        activeId !== undefined && this.searches.some((s) => s.id === activeId)
          ? activeId
          : this.searches[this.searches.length - 1]?.id;
    }

    this.persistTabState();
    this._onDidChange.fire();
  }

  public dispose(): void {
    this._onDidChange.dispose();
  }

  /** Evicts oldest searches (by `createdAt`) until the count is within `maxSearches`. */
  private evictOverflow(): void {
    while (this.searches.length > this.maxSearches) {
      const oldest = this.oldestSearch();
      if (!oldest) {
        break;
      }
      const index = this.searches.indexOf(oldest);
      this.searches.splice(index, 1);
      void this.persistence?.deleteSearch(oldest.id);
      if (this.activeSearchId === oldest.id) {
        const neighborIndex = Math.min(index, this.searches.length - 1);
        this.activeSearchId = neighborIndex >= 0 ? this.searches[neighborIndex].id : undefined;
      }
    }
  }

  private oldestSearch(): Search | undefined {
    return this.searches.reduce<Search | undefined>((oldest, search) => {
      if (!oldest || search.createdAt < oldest.createdAt) {
        return search;
      }
      return oldest;
    }, undefined);
  }

  private persistTabState(): void {
    if (!this.workspaceState) {
      return;
    }
    void this.workspaceState.update(
      TAB_ORDER_KEY,
      this.searches.map((s) => s.id)
    );
    void this.workspaceState.update(ACTIVE_ID_KEY, this.activeSearchId);
  }
}
