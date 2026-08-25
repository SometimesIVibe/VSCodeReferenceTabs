import * as vscode from "vscode";
import { PanelViewProvider } from "./panel/PanelViewProvider";
import { rerunSearch, runSearch } from "./search";
import { SearchKind } from "./model";
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
    vscode.commands.registerCommand("referenceTabs.closeActive", () => closeActiveCommand())
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

    store.closeUnpinned();
  }

  async function closeActiveCommand(): Promise<void> {
    const activeId = store.activeId;
    if (!activeId) {
      void vscode.window.showInformationMessage("Reference Tabs: no active tab to close.");
      return;
    }
    store.close(activeId);
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

  // Searches are intentionally not restored across sessions: wipe any state
  // persisted by a previous window so the panel always opens empty. The store
  // keeps writing during the session (cheap, and harmless — it is simply never
  // read back); this clears whatever the last session left behind. Fire-and-
  // forget so it never blocks activation.
  void clearPersistedState(context, persistence);
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

/** Wipes persisted searches and saved tab state so nothing is restored on the next VS Code launch. */
async function clearPersistedState(
  context: vscode.ExtensionContext,
  persistence: SearchPersistence
): Promise<void> {
  await persistence.clearAll();
  await context.workspaceState.update(TAB_ORDER_KEY, undefined);
  await context.workspaceState.update(ACTIVE_ID_KEY, undefined);
}

export function deactivate(): void {
  // No-op.
}
