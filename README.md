# Reference Tabs

A VS Code extension that replaces the built-in "Find All References" / "Find
All Implementations" flow with persistent, closable **tabs** in a dedicated
"Reference Tabs" panel (bottom area, next to Terminal/Problems).

- Each search opens as its own tab — run several searches and switch between
  them instead of losing the previous result set.
- Tabs are written to disk and restored automatically after **Reload Window**.
- Results are grouped per file, with per-group and expand-all/collapse-all
  controls.
- Preview lines are syntax-highlighted by file type (C#, TypeScript,
  JavaScript, HTML/XML, CSS, JSON, Java, Python, Go, Rust, SQL, YAML,
  Markdown, Bash), in light, dark and high-contrast themes, with the search
  match still highlighted on top even when it spans a token boundary.
- Both search commands are bound to left-hand-only shortcuts, so your right
  hand can stay on the mouse.
- Tabs can be pinned (mirroring VS Code's own editor tabs): pinned tabs sort
  leftmost, are never evicted by the tab cap, and survive "Close All Tabs
  (Keep Pinned)". A pinned tab's × is replaced by a pin glyph (click to
  unpin); middle-click still closes it outright.

<!-- TODO: screenshot of the Reference Tabs panel with two open tabs, one expanded -->

## Install

Install from a packaged `.vsix`:

```sh
code --install-extension vscode-reference-tabs-0.3.0.vsix
```

## Shortcuts

| Keybinding   | Command                                | When                                           |
| ------------ | --------------------------------------- | ----------------------------------------------- |
| `Ctrl+Alt+A` | Reference Tabs: Find All References     | `editorHasReferenceProvider && editorTextFocus` |
| `Ctrl+Alt+S` | Reference Tabs: Find All Implementations | `editorHasImplementationProvider && editorTextFocus` |

Both are rebindable via **Preferences: Open Keyboard Shortcuts**.

## Commands

| Command ID                          | Title                                        | Notes                                     |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------- |
| `referenceTabs.findReferences`       | Reference Tabs: Find All References           | Also on the editor context menu.          |
| `referenceTabs.findImplementations`  | Reference Tabs: Find All Implementations      | Also on the editor context menu.          |
| `referenceTabs.rerun`                | Reference Tabs: Re-run Search                 | Panel title-bar button (refresh icon).    |
| `referenceTabs.togglePin`            | Reference Tabs: Pin/Unpin Active Tab          | Command palette only; acts on the active tab. |
| `referenceTabs.clearAll`             | Reference Tabs: Close All Tabs                | Panel title-bar button (clear-all icon). Closes pinned tabs too. |
| `referenceTabs.closeUnpinned`        | Reference Tabs: Close All Tabs (Keep Pinned)  | Panel title-bar button (close-all icon). Leaves pinned tabs open. |

## Settings

| Setting                     | Type    | Default | Description                                                                                                                    |
| ---------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `referenceTabs.autoReveal`   | boolean | `true`  | Focus the Reference Tabs panel after running a search. When disabled, new/updated results are shown silently (the view badge still updates). |
| `referenceTabs.maxSearches`  | number  | `30`    | Maximum number of search tabs to keep. The oldest tab is evicted once this limit is exceeded.                                   |

## Replacing the built-in reference search

VS Code ships its own reference/implementation UI (the "Peek" popups and the
References side-bar view). To avoid two competing UIs fighting for the same
shortcuts, do the following.

### 1. Disable the built-in Reference Search View extension

Open the **Extensions** view → search `@builtin references` → **Reference
Search View** (id `vscode.references-view`) → gear icon → **Disable** →
**Restart Extension Host** (or reload the window).

This removes:

- The **References** side-bar view and its history.
- The `Find All References` / `Find All Implementations` commands it
  contributes (`references-view.findReferences`,
  `references-view.findImplementations`) and their `shift+alt+f12` /
  peek-vs-view routing.

**Trade-off:** the same built-in extension also provides **Call Hierarchy**
and **Type Hierarchy** (`references-view.showCallHierarchy`,
`references-view.showTypeHierarchy`, `shift+alt+h`). Disabling the extension
removes those too. If you still want call/type hierarchy, **leave the
extension enabled** and only unbind the specific keys in the next step
instead of disabling it outright.

### 2. Unbind the built-in keybindings

The `shift+alt+f12` binding disappears with the extension disabled (step 1).
The remaining bindings below belong to **core** VS Code (`editor.action.*`),
not the extension, so they exist regardless of step 1 and must be unbound
separately. Open **Preferences: Open Keyboard Shortcuts (JSON)** and paste:

```jsonc
[
  { "key": "shift+alt+f12", "command": "-references-view.findReferences" },
  { "key": "shift+f12",     "command": "-editor.action.referenceSearch.trigger" },
  { "key": "ctrl+f12",      "command": "-editor.action.goToImplementation" },
  { "key": "ctrl+shift+f12","command": "-editor.action.peekImplementation" }
]
```

Command ids confirmed against this machine's VS Code install
(`/usr/share/code/resources/app`, version 1.132):

- `references-view.findReferences` — confirmed in
  `extensions/references-view/package.json` (default key `shift+alt+f12`).
- `editor.action.referenceSearch.trigger` — confirmed in
  `out/vs/workbench/workbench.desktop.main.js` (registered command, title
  "Peek References").
- `editor.action.goToImplementation` — confirmed in
  `out/vs/workbench/workbench.desktop.main.js`.
- `editor.action.peekImplementation` — confirmed in
  `out/vs/workbench/workbench.desktop.main.js`.

The exact default key-to-command mapping (`shift+f12` / `ctrl+f12` /
`ctrl+shift+f12`) matches the standard VS Code defaults; if your build or
keyboard layout differs, double check the mapping in **Preferences: Open
Keyboard Shortcuts** before pasting the snippet.

These peek commands are **core editor commands**, not an extension — they
can only be unbound (`-command` prefix above), not removed entirely from VS
Code.

### 3. Hide the built-in context-menu entries

Unbinding a key does not remove the corresponding entry from the editor's
right-click context menu. Right-click each entry and choose **Hide**. VS Code
stores this per-menu customization internally (confirmed as the
`menu.hiddenCommands` mechanism in this build) — no manual settings edit
needed:

- **Go to References**
- **Peek** → **Peek References**
- **Peek** → **Peek Implementations**
- **Go to Implementations**

After steps 1–3, `Ctrl+Alt+A` / `Ctrl+Alt+S` and the Reference Tabs panel are
the only reference/implementation UI left; `shift+alt+f12` and the peek
shortcuts do nothing.
