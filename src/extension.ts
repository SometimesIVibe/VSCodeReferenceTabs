import * as vscode from "vscode";
import { PanelViewProvider } from "./panel/PanelViewProvider";
import { runSearch } from "./search";
import { Search, SearchKind } from "./model";
import { SearchStore } from "./store";
import { SearchPersistence } from "./persistence";

const TAB_ORDER_KEY = "referenceTabs.tabOrder";
const ACTIVE_ID_KEY = "referenceTabs.activeId";

export function activate(context: vscode.ExtensionContext): void {
  const storageUri = context.storageUri ?? context.globalStorageUri;
  const persistence = new SearchPersistence(storageUri);
  context.subscriptions.push(persistence);

  const store = new SearchStore(persistence, context.workspaceState);
  context.subscriptions.push(store);

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
    await vscode.commands.executeCommand("referenceTabs.panel.focus");
  }

  // Fire-and-forget: does not block activation. `store.seed` prepends
  // restored searches ahead of anything a user command already added while
  // this was loading, so a fast `Ctrl+Alt+A` right after window-reload
  // can't be clobbered by a slow restore.
  void restore(context, persistence, store);
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
