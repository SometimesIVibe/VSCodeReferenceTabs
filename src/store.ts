import * as vscode from "vscode";
import { AccessFilter, CallNode, Search } from "./model";
import { SearchPersistence } from "./persistence";
import { findCallNode, recomputeAndSort } from "./callTree";

/** Fallback cap on stored searches (mirrors the `referenceTabs.maxSearches` setting default) used before the setting is read. */
export const DEFAULT_MAX_SEARCHES = 30;

const TAB_ORDER_KEY = "referenceTabs.tabOrder";
const ACTIVE_ID_KEY = "referenceTabs.activeId";
/** Remembered Read/Write filter, reused as the default for new tabs. Persists across sessions (not cleared on startup like tab state). */
const ACCESS_FILTER_KEY = "referenceTabs.accessFilter";

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

  /**
   * Adds a new search and makes it the active one. Persists immediately and
   * evicts the oldest search past the configured max (see
   * {@link setMaxSearches}).
   *
   * Dedup: if an existing search already has the same `key` (deterministic
   * identity of the search *target*, distinct from the fresh GUID `id`
   * every `runSearch` mints — see `model.ts`), that entry is updated in
   * place instead of opening a new tab: its `id`, `pinned` flag, and tab
   * position are kept, while `search`'s fresh `groups`/`totalCount`/
   * `createdAt`/origin fields win. The merged entry is saved under the KEPT
   * id (nothing is deleted, no new file is written) and becomes active. No
   * eviction check runs in this branch — the tab count didn't grow.
   */
  public add(search: Search): void {
    const existingIndex = this.searches.findIndex((s) => s.key === search.key);
    if (existingIndex !== -1) {
      const existing = this.searches[existingIndex];
      const merged: Search = {
        ...search,
        id: existing.id,
        pinned: existing.pinned,
        accessFilter: existing.accessFilter,
      };
      this.searches[existingIndex] = merged;
      this.activeSearchId = merged.id;

      void this.persistence?.saveSearch(merged);
      this.persistTabState();
      this._onDidChange.fire();
      return;
    }

    // A new tab starts from the remembered filter, but only where it applies.
    search.accessFilter = search.accessAware ? this.lastAccessFilter : "none";
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
   * `pinned` is always carried over from the existing entry — rerun must
   * never silently unpin a tab. No-op if no search with that id exists.
   * Persists and notifies.
   */
  public replace(search: Search): void {
    const index = this.searches.findIndex((s) => s.id === search.id);
    if (index === -1) {
      return;
    }
    const previous = this.searches[index];
    const replaced: Search = {
      ...search,
      pinned: previous.pinned,
      accessFilter: previous.accessFilter,
    };
    this.searches[index] = replaced;
    void this.persistence?.saveSearch(replaced);
    this._onDidChange.fire();
  }

  /**
   * Flips the pinned flag of `id` and re-sorts it per VS Code editor-tab
   * semantics: pinned tabs occupy the left of the tab bar in their existing
   * relative order, unpinned follow. Pinning moves the tab to the end of the
   * pinned block; unpinning moves it to the front of the unpinned block —
   * both are the same boundary index once the tab is removed from its old
   * position, so a single insertion point is computed either way.
   *
   * Saves immediately (not debounced — pinning is a deliberate action), and
   * persists the new tab order. No-op if `id` is unknown.
   */
  public togglePin(id: string): void {
    const index = this.searches.findIndex((s) => s.id === id);
    if (index === -1) {
      return;
    }
    const search = this.searches[index];
    search.pinned = !search.pinned;
    this.searches.splice(index, 1);

    let insertAt = 0;
    while (insertAt < this.searches.length && this.searches[insertAt].pinned) {
      insertAt++;
    }
    this.searches.splice(insertAt, 0, search);

    void this.persistence?.saveSearch(search);
    this.persistTabState();
    this._onDidChange.fire();
  }

  /** Closes every tab and deletes all persisted search files, pinned included. */
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
   * Closes every *unpinned* tab (deletes their persisted files) and leaves
   * pinned tabs untouched. If the active tab was among the closed ones,
   * activates the first remaining (necessarily pinned) tab. No-op if there
   * are no unpinned tabs.
   */
  public closeUnpinned(): void {
    const idsToClose = this.searches.filter((s) => !s.pinned).map((s) => s.id);
    if (idsToClose.length === 0) {
      return;
    }
    const closingActive =
      this.activeSearchId !== undefined && idsToClose.includes(this.activeSearchId);

    for (let i = this.searches.length - 1; i >= 0; i--) {
      if (!this.searches[i].pinned) {
        this.searches.splice(i, 1);
      }
    }

    for (const id of idsToClose) {
      void this.persistence?.deleteSearch(id);
    }

    if (closingActive) {
      this.activeSearchId = this.searches[0]?.id;
    }

    this.persistTabState();
    this._onDidChange.fire();
  }

  /**
   * Closes every OTHER unpinned tab, deleting their persisted files. Pinned
   * tabs and the target `id` itself always survive (VS Code editor-tab
   * "Close Others" semantics), regardless of the target's own pinned state.
   * The target becomes the active tab. No confirmation (matches VS Code).
   * No-op if `id` is unknown or there is nothing else to close.
   */
  public closeOthers(id: string): void {
    if (!this.searches.some((s) => s.id === id)) {
      return;
    }
    const idsToClose = this.searches
      .filter((s) => s.id !== id && !s.pinned)
      .map((s) => s.id);
    if (idsToClose.length === 0) {
      return;
    }

    for (let i = this.searches.length - 1; i >= 0; i--) {
      const search = this.searches[i];
      if (search.id !== id && !search.pinned) {
        this.searches.splice(i, 1);
      }
    }

    for (const closedId of idsToClose) {
      void this.persistence?.deleteSearch(closedId);
    }

    this.activeSearchId = id;

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

  /**
   * The root caller arrays of a call-hierarchy search: the per-group root
   * lists for an interface search, or the single `callTree` otherwise. A node
   * lookup/roll-up is scoped to whichever array actually holds the node.
   */
  private callRootArrays(search: Search): CallNode[][] {
    if (search.callGroups) {
      return search.callGroups.map((group) => group.roots);
    }
    return search.callTree ? [search.callTree] : [];
  }

  /** Looks up a call-hierarchy node by id anywhere in a search (flat tree or any group); `undefined` if absent. */
  public getCallNode(searchId: string, nodeId: string): CallNode | undefined {
    const search = this.searches.find((s) => s.id === searchId);
    if (!search) {
      return undefined;
    }
    for (const roots of this.callRootArrays(search)) {
      const node = findCallNode(roots, nodeId);
      if (node) {
        return node;
      }
    }
    return undefined;
  }

  /**
   * Attaches lazily-fetched callers to a call-hierarchy node, marks it
   * loaded + expanded, and re-rolls-up/re-sorts the tree it belongs to (test
   * branches to the bottom). Debounce-persists and notifies.
   */
  public setCallNodeChildren(searchId: string, nodeId: string, children: CallNode[]): void {
    const search = this.searches.find((s) => s.id === searchId);
    if (!search) {
      return;
    }
    for (const roots of this.callRootArrays(search)) {
      const node = findCallNode(roots, nodeId);
      if (!node) {
        continue;
      }
      node.children = children;
      node.loaded = true;
      node.expanded = true;
      recomputeAndSort(roots);
      this.persistence?.scheduleSave(search);
      this._onDidChange.fire();
      return;
    }
  }

  /** Toggles the expand state of an already-loaded call-hierarchy node. Debounce-persists and notifies. */
  public setCallNodeExpanded(searchId: string, nodeId: string, expanded: boolean): void {
    const node = this.getCallNode(searchId, nodeId);
    if (!node || node.expanded === expanded) {
      return;
    }
    node.expanded = expanded;
    const search = this.searches.find((s) => s.id === searchId);
    if (search) {
      this.persistence?.scheduleSave(search);
    }
    this._onDidChange.fire();
  }

  /** The Read/Write filter last chosen by the user, used as the default for new access-aware tabs. Persists across sessions. */
  public get lastAccessFilter(): AccessFilter {
    return this.workspaceState?.get<AccessFilter>(ACCESS_FILTER_KEY) ?? "none";
  }

  /**
   * Sets a tab's Read/Write filter and remembers it as the default for future
   * tabs. No-op for a search that isn't access-aware or when unchanged.
   */
  public setAccessFilter(id: string, filter: AccessFilter): void {
    const search = this.searches.find((s) => s.id === id);
    if (!search || !search.accessAware || search.accessFilter === filter) {
      return;
    }
    search.accessFilter = filter;
    void this.workspaceState?.update(ACCESS_FILTER_KEY, filter);
    this.persistence?.scheduleSave(search);
    this._onDidChange.fire();
  }

  /** Toggles the collapse state of a call-hierarchy group (interface/implementation section). Debounce-persists and notifies. */
  public setCallGroupCollapsed(searchId: string, groupId: string, collapsed: boolean): void {
    const search = this.searches.find((s) => s.id === searchId);
    const group = search?.callGroups?.find((g) => g.id === groupId);
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

  /**
   * Evicts oldest *unpinned* searches (by `createdAt`) until the unpinned
   * count is within `maxSearches`. Pinned searches never count toward the
   * cap and are never evicted — if every search is pinned, the cap may be
   * exceeded rather than evicting a pinned tab or blocking a new search.
   */
  private evictOverflow(): void {
    while (this.unpinnedCount() > this.maxSearches) {
      const oldest = this.oldestUnpinnedSearch();
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

  private unpinnedCount(): number {
    return this.searches.reduce((count, search) => (search.pinned ? count : count + 1), 0);
  }

  private oldestUnpinnedSearch(): Search | undefined {
    return this.searches.reduce<Search | undefined>((oldest, search) => {
      if (search.pinned) {
        return oldest;
      }
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
