// Plain-JS webview UI for the Reference Tabs panel. No framework — the UI
// is small enough that a tiny render-from-last-state function plus event
// delegation is simpler than any bundler/framework setup.

(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");

  /** @type {{ searches: Array<{id:string,kind:string,symbol:string,totalCount:number}>, active: any } | null} */
  let lastState = null;

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "state") {
      lastState = { searches: message.searches, active: message.active };
      render();
    }
  });

  root.addEventListener("click", onClick);

  vscode.postMessage({ type: "ready" });

  function onClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const closeBtn = target.closest(".tab-close");
    if (closeBtn) {
      const id = closeBtn.getAttribute("data-id");
      if (id) {
        vscode.postMessage({ type: "closeTab", id });
      }
      return;
    }

    const tab = target.closest(".tab");
    if (tab) {
      const id = tab.getAttribute("data-id");
      if (id) {
        vscode.postMessage({ type: "selectTab", id });
      }
      return;
    }

    const actionBtn = target.closest(".icon-btn");
    if (actionBtn) {
      const action = actionBtn.getAttribute("data-action");
      const activeId = lastState && lastState.active ? lastState.active.id : null;
      if (!activeId) {
        return;
      }
      if (action === "expand-all") {
        vscode.postMessage({ type: "setAllGroups", id: activeId, collapsed: false });
      } else if (action === "collapse-all") {
        vscode.postMessage({ type: "setAllGroups", id: activeId, collapsed: true });
      }
      return;
    }

    const groupHeader = target.closest(".group-header");
    if (groupHeader) {
      const uri = groupHeader.getAttribute("data-uri");
      const activeId = lastState && lastState.active ? lastState.active.id : null;
      if (uri && activeId) {
        const collapsed = groupHeader.getAttribute("data-collapsed") !== "true";
        vscode.postMessage({ type: "toggleGroup", id: activeId, uri, collapsed });
      }
      return;
    }

    const resultRow = target.closest(".result-row");
    if (resultRow) {
      const uri = resultRow.getAttribute("data-uri");
      const line = Number(resultRow.getAttribute("data-line"));
      const character = Number(resultRow.getAttribute("data-character"));
      const endCharacter = Number(resultRow.getAttribute("data-end-character"));
      if (uri) {
        vscode.postMessage({ type: "open", uri, line, character, endCharacter });
      }
      return;
    }
  }

  function render() {
    if (!lastState || lastState.searches.length === 0) {
      root.innerHTML = getEmptyHtml();
      return;
    }
    root.innerHTML = getPanelHtml(lastState.searches, lastState.active);
  }

  function getEmptyHtml() {
    return `<div class="placeholder">No searches yet — press Ctrl+Alt+A on a symbol</div>`;
  }

  function getPanelHtml(searches, active) {
    const activeId = active ? active.id : null;
    return `<div class="panel">
  <div class="tabbar-row">
    <div class="tabbar" role="tablist">${searches.map((s) => getTabHtml(s, s.id === activeId)).join("")}</div>
    <div class="toolbar-actions">
      <button class="icon-btn" data-action="expand-all" title="Expand All">Expand All</button>
      <button class="icon-btn" data-action="collapse-all" title="Collapse All">Collapse All</button>
    </div>
  </div>
  <div class="body">${active ? getGroupsHtml(active) : ""}</div>
</div>`;
  }

  function getTabHtml(search, isActive) {
    const kindBadge = search.kind === "references" ? "R" : "I";
    const kindClass = search.kind === "references" ? "kind-references" : "kind-implementations";
    const id = escapeAttr(search.id);
    return `<div class="tab${isActive ? " active" : ""}" data-id="${id}" role="tab" aria-selected="${isActive}">
  <span class="tab-badge ${kindClass}">${kindBadge}</span>
  <span class="tab-symbol" title="${escapeAttr(search.symbol)}">${escapeHtml(search.symbol)}</span>
  <span class="tab-count">${search.totalCount}</span>
  <button class="tab-close" data-id="${id}" title="Close">&times;</button>
</div>`;
  }

  function getGroupsHtml(search) {
    return search.groups.map((group) => getGroupHtml(group)).join("");
  }

  function getGroupHtml(group) {
    const uri = escapeAttr(group.uri);
    const chevron = group.collapsed ? "▸" : "▾";
    const itemsClass = group.collapsed ? " collapsed" : "";
    const items = group.items
      .map((item) => getResultRowHtml(group.uri, item))
      .join("");
    return `<div class="group">
  <div class="group-header" data-uri="${uri}" data-collapsed="${group.collapsed ? "true" : "false"}">
    <span class="chevron">${chevron}</span>
    <span class="group-path" title="${escapeAttr(group.relativePath)}">${escapeHtml(group.relativePath)}</span>
    <span class="group-count">${group.items.length}</span>
  </div>
  <div class="group-items${itemsClass}">${items}</div>
</div>`;
  }

  function getResultRowHtml(uri, item) {
    const lineText = item.lineText || "";
    const start = clamp(item.character, 0, lineText.length);
    const end = clamp(item.endCharacter, start, lineText.length);

    const before = lineText.slice(0, start);
    const match = lineText.slice(start, end);
    const after = lineText.slice(end);

    const textHtml =
      escapeHtml(before) +
      (match.length > 0 ? `<span class="match">${escapeHtml(match)}</span>` : "") +
      escapeHtml(after);

    return `<div class="result-row" data-uri="${escapeAttr(uri)}" data-line="${item.line}" data-character="${item.character}" data-end-character="${item.endCharacter}">
  <span class="result-line-number">${item.line + 1}</span>
  <span class="result-text">${textHtml}</span>
</div>`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
