import * as vscode from "vscode";
import { PanelViewProvider } from "./panel/PanelViewProvider";
import { runSearch } from "./search";
import { SearchKind } from "./model";
import { SearchStore } from "./store";

export function activate(context: vscode.ExtensionContext): void {
  const store = new SearchStore();
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
}

export function deactivate(): void {
  // No-op.
}
