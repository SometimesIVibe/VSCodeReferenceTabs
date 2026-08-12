import * as vscode from "vscode";

/**
 * Provides the "Reference Tabs" WebviewView shown in the panel area.
 *
 * Step 1: renders a static placeholder shell only. Tab bar, search results,
 * and message passing land in later steps.
 */
export class PanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "referenceTabs.panel";

  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();
  }

  /** Placeholder for later steps: post a message to the webview. */
  public postMessage(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reference Tabs</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 16px;
      box-sizing: border-box;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="placeholder">No searches yet — press Ctrl+Alt+A on a symbol</div>
</body>
</html>`;
  }
}
