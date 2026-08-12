import * as vscode from "vscode";
import { PanelViewProvider } from "./panel/PanelViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PanelViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PanelViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("referenceTabs.findReferences", async () => {
      // Stub for Step 1: reveal the panel. Real search logic lands in Step 2.
      await vscode.commands.executeCommand("referenceTabs.panel.focus");
      provider.postMessage({ type: "stub", command: "findReferences" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("referenceTabs.findImplementations", async () => {
      // Stub for Step 1: reveal the panel. Real search logic lands in Step 2.
      await vscode.commands.executeCommand("referenceTabs.panel.focus");
      provider.postMessage({ type: "stub", command: "findImplementations" });
    })
  );
}

export function deactivate(): void {
  // No-op for Step 1.
}
