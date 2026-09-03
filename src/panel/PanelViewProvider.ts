import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { SearchStore } from "../store";
import { incomingCallsFor, loadChildLevel } from "../callHierarchy";
import {
  SearchSummary,
  StateMessage,
  WebviewToExtensionMessage,
} from "./messages";

/**
 * Provides the "Reference Tabs" WebviewView shown in the panel area.
 *
 * Renders a static HTML shell that loads `media/panel.css` and
 * `media/panel.js`; all actual tab/group/result rendering happens in the
 * webview via the `state` message. This provider's job is: serve the shell,
 * translate `SearchStore` state into `state` messages, and translate
 * webview messages back into `SearchStore` mutations / editor commands.
 */
export class PanelViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "referenceTabs.panel";

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: SearchStore
  ) {
    this.disposables.push(this.store.onDidChange(() => this.pushState()));
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) =>
        this.handleMessage(message)
      )
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private handleMessage(message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case "ready":
        this.pushState();
        break;
      case "selectTab":
        this.store.setActive(message.id);
        break;
      case "closeTab":
        this.store.close(message.id);
        break;
      case "toggleGroup":
        this.store.toggleGroup(message.id, message.uri, message.collapsed);
        break;
      case "setAllGroups":
        this.store.setAllGroups(message.id, message.collapsed);
        break;
      case "togglePin":
        this.store.togglePin(message.id);
        break;
      case "toggleCallNode":
        void this.toggleCallNode(message.id, message.nodeId);
        break;
      case "toggleCallGroup":
        this.store.setCallGroupCollapsed(message.id, message.groupId, message.collapsed);
        break;
      case "setAccessFilter":
        this.store.setAccessFilter(message.id, message.filter);
        break;
      case "closeOthers":
        this.store.closeOthers(message.id);
        break;
      case "closeAll":
        void vscode.commands.executeCommand("referenceTabs.clearAll");
        break;
      case "closeAllKeepPinned":
        void vscode.commands.executeCommand("referenceTabs.closeUnpinned");
        break;
      case "open":
        void this.openLocation(message);
        break;
    }
  }

  /**
   * Expands or collapses a call-hierarchy node. Collapsing is a pure toggle.
   * Expanding pre-fetches one level below the children about to be shown (a
   * one-breadth-down lookahead) so their test-branch state — including "only
   * used by tests" — is already known when they appear, rather than filled in
   * only after the user expands them in turn. The node's own children are
   * normally already loaded from its parent's lookahead; the fallback fetches
   * them if not.
   */
  private async toggleCallNode(searchId: string, nodeId: string): Promise<void> {
    const node = this.store.getCallNode(searchId, nodeId);
    if (!node) {
      return;
    }
    if (node.expanded) {
      this.store.setCallNodeExpanded(searchId, nodeId, false);
      return;
    }
    try {
      const children = node.loaded ? node.children : await incomingCallsFor(node);
      await loadChildLevel(children);
      this.store.setCallNodeChildren(searchId, nodeId, children);
    } catch {
      void vscode.window.showWarningMessage("Reference Tabs: could not load callers.");
    }
  }

  private async openLocation(message: {
    uri: string;
    line: number;
    character: number;
    endCharacter: number;
  }): Promise<void> {
    try {
      const uri = vscode.Uri.parse(message.uri);
      const selection = new vscode.Range(
        new vscode.Position(message.line, message.character),
        new vscode.Position(message.line, message.endCharacter)
      );
      await vscode.window.showTextDocument(uri, {
        selection,
        preserveFocus: false,
      });
    } catch {
      void vscode.window.showWarningMessage("Reference Tabs: could not open that location.");
    }
  }

  /** Posts the current `SearchStore` state to the webview (summaries for every tab, full data for the active one only). */
  private pushState(): void {
    if (!this.view) {
      return;
    }

    const searches = this.store.all;
    const activeId = this.store.activeId;

    const summaries: SearchSummary[] = searches.map((search) => ({
      id: search.id,
      kind: search.kind,
      symbol: search.symbol,
      totalCount: search.totalCount,
      pinned: search.pinned,
    }));

    const active = searches.find((search) => search.id === activeId) ?? null;

    const message: StateMessage = {
      type: "state",
      searches: summaries,
      active,
    };

    void this.view.webview.postMessage(message);
    this.updateBadge();
  }

  /** Mirrors the number of open search tabs onto the view's badge (visible even when the panel isn't focused, e.g. with `autoReveal` off). Clears the badge when there are no tabs. */
  private updateBadge(): void {
    if (!this.view) {
      return;
    }
    const tabCount = this.store.all.length;
    if (!tabCount) {
      this.view.badge = undefined;
      return;
    }
    this.view.badge = {
      value: tabCount,
      tooltip: `${tabCount} open tab${tabCount === 1 ? "" : "s"}`,
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.css")
    );
    const hljsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "hljs.js")
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.js")
    );

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <!-- CSP forbids inline style="" attributes (no 'unsafe-inline'); the
       context menu's cursor-position left/top are instead written into this
       nonce'd stylesheet's text at runtime (media/panel.js), which is
       CSP-safe since the nonce is only checked when the element is
       inserted, not on later text mutations. -->
  <style nonce="${nonce}" id="context-menu-position-style"></style>
  <title>Reference Tabs</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${hljsUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return randomBytes(16).toString("base64");
}
