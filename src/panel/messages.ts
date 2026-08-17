/**
 * Message protocol between the extension host (`PanelViewProvider`) and the
 * webview (`media/panel.js`).
 *
 * Kept as plain, structurally-typed objects (no classes, no `vscode.*`
 * types) so the same shapes can be used unmodified inside the webview's
 * plain-JS runtime.
 */

import { Search, SearchKind } from "../model";

/** Lightweight per-search info for the tab bar — avoids shipping full result data for inactive tabs. */
export interface SearchSummary {
  id: string;
  kind: SearchKind;
  symbol: string;
  totalCount: number;
  pinned: boolean;
}

/** ext -> webview: full UI state. `active` is the full `Search` for the active tab only, or `null` if there are no tabs. */
export interface StateMessage {
  type: "state";
  searches: SearchSummary[];
  active: Search | null;
}

export type ExtensionToWebviewMessage = StateMessage;

/** webview -> ext: initial handshake, sent once on load; provider replies with the current state. */
export interface ReadyMessage {
  type: "ready";
}

/** webview -> ext: user clicked a tab. */
export interface SelectTabMessage {
  type: "selectTab";
  id: string;
}

/** webview -> ext: user clicked a tab's close (x) button. */
export interface CloseTabMessage {
  type: "closeTab";
  id: string;
}

/** webview -> ext: user clicked a result row; extension should open the location. */
export interface OpenMessage {
  type: "open";
  uri: string;
  line: number;
  character: number;
  endCharacter: number;
}

/** webview -> ext: user toggled a single file group's collapse state. */
export interface ToggleGroupMessage {
  type: "toggleGroup";
  id: string;
  uri: string;
  collapsed: boolean;
}

/** webview -> ext: user clicked expand-all / collapse-all for the active search. */
export interface SetAllGroupsMessage {
  type: "setAllGroups";
  id: string;
  collapsed: boolean;
}

/** webview -> ext: user clicked a tab's pin/unpin glyph. */
export interface TogglePinMessage {
  type: "togglePin";
  id: string;
}

/** webview -> ext: context-menu "Close Others" — closes every other unpinned tab. */
export interface CloseOthersMessage {
  type: "closeOthers";
  id: string;
}

/** webview -> ext: context-menu "Close All" — runs the `referenceTabs.clearAll` command (keeps its confirmation flow). */
export interface CloseAllMessage {
  type: "closeAll";
}

/** webview -> ext: context-menu "Close All (Keep Pinned)" — runs the `referenceTabs.closeUnpinned` command (keeps its confirmation flow). */
export interface CloseAllKeepPinnedMessage {
  type: "closeAllKeepPinned";
}

export type WebviewToExtensionMessage =
  | ReadyMessage
  | SelectTabMessage
  | CloseTabMessage
  | OpenMessage
  | ToggleGroupMessage
  | SetAllGroupsMessage
  | TogglePinMessage
  | CloseOthersMessage
  | CloseAllMessage
  | CloseAllKeepPinnedMessage;
