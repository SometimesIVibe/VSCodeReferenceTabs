import * as vscode from "vscode";
import { PanelViewProvider } from "./panel/PanelViewProvider";
import { rerunSearch, runSearch } from "./search";
import { Search, SearchKind } from "./model";
import { DEFAULT_MAX_SEARCHES, SearchStore } from "./store";
import { SearchPersistence } from "./persistence";

const TAB_ORDER_KEY = "referenceTabs.tabOrder";
const ACTIVE_ID_KEY = "referenceTabs.activeId";
const CONFIG_SECTION = "referenceTabs";

export function activate(context: vscode.ExtensionContext): void {
  const storageUri = context.storageUri ?? context.globalStorageUri;
  const persistence = new SearchPersistence(storageUri);
  context.subscriptions.push(persistence);

  const store = new SearchStore(persistence, context.workspaceState);
  context.subscriptions.push(store);
  store.setMaxSearches(readMaxSearches());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        store.setMaxSearches(readMaxSearches());
      }
    })
  );

  const provider = new PanelViewProvider(context.extensionUri, store);
  context.subscriptions.push(provider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PanelViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("referenceTabs.findReferences", () =>
      runSearchCommand("references")
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("referenceTabs.findImplementations", () =>
      runSearchCommand("implementations")
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("referenceTabs.clearAll", () => clearAllCommand())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("referenceTabs.closeUnpinned", () => closeUnpinnedCommand())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("referenceTabs.togglePin", () => togglePinCommand())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("referenceTabs.rerun", () => rerunCommand())
  );

  async function runSearchCommand(kind: SearchKind): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Reference Tabs: no active editor.");
      return;
    }

    const search = await runSearch(kind, editor);
    if (!search) {
      // runSearch already showed a user-facing message; no tab to create.
      return;
    }

    store.add(search);

    if (readAutoReveal()) {
      await vscode.commands.executeCommand("referenceTabs.panel.focus");
    }
  }

  async function clearAllCommand(): Promise<void> {
    if (store.all.length === 0) {
      void vscode.window.showInformationMessage("Reference Tabs: no tabs to clear.");
      return;
    }

    const pinnedCount = store.all.filter((search) => search.pinned).length;
    const message =
      pinnedCount > 0
        ? `Reference Tabs: close all tabs and delete their saved results, including ${pinnedCount} pinned tab${pinnedCount === 1 ? "" : "s"}?`
        : "Reference Tabs: close all tabs and delete their saved results?";

    const yes = "Yes";
    const choice = await vscode.window.showWarningMessage(message, { modal: false }, yes);
    if (choice !== yes) {
      return;
    }

    store.clearAll();
  }

  async function closeUnpinnedCommand(): Promise<void> {
    const unpinnedCount = store.all.filter((search) => !search.pinned).length;
    const pinnedCount = store.all.length - unpinnedCount;

    if (unpinnedCount === 0) {
      void vscode.window.showInformationMessage(
        pinnedCount > 0
          ? "Reference Tabs: no unpinned tabs to close."
          : "Reference Tabs: no tabs to close."
      );
      return;
    }

    const message =
      pinnedCount > 0
        ? `Reference Tabs: close ${unpinnedCount} tab${unpinnedCount === 1 ? "" : "s"}? ${pinnedCount} pinned tab${pinnedCount === 1 ? "" : "s"} ${pinnedCount === 1 ? "is" : "are"} kept.`
        : "Reference Tabs: close all tabs and delete their saved results?";

    const yes = "Yes";
    const choice = await vscode.window.showWarningMessage(message, { modal: false }, yes);
    if (choice !== yes) {
      return;
    }

    store.closeUnpinned();
  }

  async function togglePinCommand(): Promise<void> {
    const activeId = store.activeId;
    if (!activeId) {
      void vscode.window.showInformationMessage("Reference Tabs: no active tab to pin.");
      return;
    }
    store.togglePin(activeId);
  }

  async function rerunCommand(): Promise<void> {
    const activeId = store.activeId;
    const activeSearch = store.all.find((search) => search.id === activeId);
    if (!activeSearch) {
      void vscode.window.showInformationMessage("Reference Tabs: no active tab to re-run.");
      return;
    }

    const refreshed = await rerunSearch(activeSearch);
    if (!refreshed) {
      // rerunSearch already showed a user-facing message; keep old results.
      return;
    }

    store.replace(refreshed);
  }

  // Fire-and-forget: does not block activation. `store.seed` prepends
  // restored searches ahead of anything a user command already added while
  // this was loading, so a fast `Ctrl+Alt+A` right after window-reload
  // can't be clobbered by a slow restore.
  void restore(context, persistence, store);
}

function readMaxSearches(): number {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>("maxSearches", DEFAULT_MAX_SEARCHES);
  return typeof value === "number" && value > 0 ? value : DEFAULT_MAX_SEARCHES;
}

function readAutoReveal(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("autoReveal", true);
}

/** Loads persisted searches, orders them by the saved tab order (falling back to `createdAt`), and seeds `store`. */
async function restore(
  context: vscode.ExtensionContext,
  persistence: SearchPersistence,
  store: SearchStore
): Promise<void> {
  const loaded = await persistence.loadAll();
  if (loaded.length === 0) {
    return;
  }

  const savedOrder = context.workspaceState.get<string[]>(TAB_ORDER_KEY) ?? [];
  const savedActiveId = context.workspaceState.get<string>(ACTIVE_ID_KEY);

  const ordered = orderByTabOrder(loaded, savedOrder);
  const activeId =
    savedActiveId !== undefined && ordered.some((s) => s.id === savedActiveId)
      ? savedActiveId
      : ordered[ordered.length - 1]?.id;

  store.seed(ordered, activeId);
}

/** Orders `searches` by their position in `savedOrder`; searches missing from `savedOrder` are appended, sorted by `createdAt` ascending. */
function orderByTabOrder(searches: readonly Search[], savedOrder: readonly string[]): Search[] {
  const byId = new Map(searches.map((s) => [s.id, s]));
  const ordered: Search[] = [];

  for (const id of savedOrder) {
    const search = byId.get(id);
    if (search) {
      ordered.push(search);
      byId.delete(id);
    }
  }

  const remaining = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  ordered.push(...remaining);

  return ordered;
}

export function deactivate(): void {
  // No-op.
}
