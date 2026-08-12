import * as vscode from "vscode";
import { Search } from "../model";
import { SearchStore } from "../store";

/**
 * Provides the "Reference Tabs" WebviewView shown in the panel area.
 *
 * Step 2: renders a crude, HTML-escaped debug list of the store's searches
 * (tab name = symbol + kind + total, one line per file with its match
 * count). The real tabbed/collapsible UI lands in Step 3.
 */
export class PanelViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "referenceTabs.panel";

  private view?: vscode.WebviewView;
  private readonly storeSubscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: SearchStore
  ) {
    this.storeSubscription = this.store.onDidChange(() => this.render());
  }

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

    this.render();
  }

  /** Placeholder for later steps: post a message to the webview. */
  public postMessage(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  public dispose(): void {
    this.storeSubscription.dispose();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const searches = this.store.all;
    const body =
      searches.length === 0 ? this.getEmptyHtml() : this.getDebugListHtml(searches);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reference Tabs</title>
  <style>
    ${this.getCss()}
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
  }

  private getEmptyHtml(): string {
    return `<div class="placeholder">No searches yet — press Ctrl+Alt+A on a symbol</div>`;
  }

  /** Crude debug rendering — real tab bar + collapsible groups arrive in Step 3. */
  private getDebugListHtml(searches: readonly Search[]): string {
    const activeId = this.store.activeId;

    const entries = searches
      .map((search) => {
        const kindLabel = search.kind === "references" ? "refs" : "impl";
        const header = `${escapeHtml(search.symbol)} (${kindLabel}) — ${search.totalCount}`;
        const files = search.groups
          .map(
            (group) =>
              `<li>${escapeHtml(group.relativePath)} (${group.items.length})</li>`
          )
          .join("");
        const activeClass = search.id === activeId ? " active" : "";

        return `<div class="search${activeClass}">
    <div class="search-header">${header}</div>
    <ul class="file-list">${files}</ul>
  </div>`;
      })
      .join("\n");

    return `<div class="debug-list">\n${entries}\n</div>`;
  }

  private getCss(): string {
    return `
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
    .debug-list {
      padding: 8px;
      box-sizing: border-box;
    }
    .search {
      margin-bottom: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 6px 8px;
    }
    .search.active {
      border-color: var(--vscode-focusBorder);
    }
    .search-header {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .file-list {
      margin: 0;
      padding-left: 18px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    `;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
