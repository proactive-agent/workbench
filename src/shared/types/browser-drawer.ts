/**
 * The browser drawer: the headless browsers Claude chats open with the Playwright connector, shown
 * and driven inside Workbench (src/main/browser-drawer/). Task runs' browsers stay headless and unseen
 */

import type { DownloadableBrowser } from './browser-profiles';

/** A live browser of a Playwright MCP server */
export interface BrowserDrawerSession {
  /** The browser's guid in Playwright's registry */
  id: string;
  /** The session's title (the MCP client's name) */
  title: string;
  browserName: string;
  /** Playwright's own browser build, not one installed by the user (its tabs show Playwright's icon) */
  managed?: boolean;
  workspaceDir?: string;
  /** The project whose chat it belongs to (none for task runs' and other tools' browsers) */
  projectId?: string;
  /** The chat whose browser it is (chat browsers, held by Workbench: chat-browsers.ts) */
  chatId?: string;
}

/** The New chat page's chat id (before its first message creates the conversation) */
export const NEW_CHAT_BROWSER_ID = 'new';

/** A chat's browser, being opened or open */
export interface ChatBrowserInfo {
  projectId: string;
  /** The chat's conversation id, or NEW_CHAT_BROWSER_ID */
  chatId: string;
  /**
   * restorable: it closed when Workbench stopped unexpectedly; opening it brings back its sign-ins
   * and tabs. saved: it was closed with tabs open, which open again with it
   */
  status: 'starting' | 'open' | 'restorable' | 'saved';
  /** A restorable or saved browser's tabs that open again */
  tabs?: number;
}

/** An item of a browser profile's bookmarks bar: a bookmark (url) or a folder (children) */
export interface BrowserBookmark {
  title: string;
  url?: string;
  children?: BrowserBookmark[];
}

/** An extension of a chat browser's profile, which the drawer lists next to its address bar */
export interface BrowserExtension {
  id: string;
  name: string;
  /** Switched on (Firefox: as its switch is, which may wait for the browser to start again) */
  enabled: boolean;
  /** Pinned to the browser's toolbar: shown beside the address bar */
  pinned: boolean;
  /** Its icon, as a data: URL */
  icon?: string;
}

/** A chat browser's extensions (none: it runs without them, Settings > Browser) */
export interface BrowserExtensions {
  /** The browser profile's id, which the switches are kept by (BrowserSettings.extensionSwitches) */
  browserId: string;
  extensions: BrowserExtension[];
  /** Some switches take effect only once the browser starts again (Firefox reads them at start) */
  restartToApply?: boolean;
  /** Clicking an extension opens its popup or runs its action, as the browser's button does (Chromium) */
  canOpen?: boolean;
}

/** A page (tab) of a session's browser */
export interface BrowserDrawerPage {
  id: string;
  sessionId: string;
  title: string;
  url: string;
  /** A navigation of the page is loading (from its request until the page's load event) */
  loading?: boolean;
  /** Its tab has a page to go back to, or forward to (the toolbar's Back and Forward) */
  canGoBack?: boolean;
  canGoForward?: boolean;
  /**
   * An extension's popup (not a tab): shown over the page it opened for, at its own size (CSS
   * pixels), as the browser shows it under the extension's button
   */
  popup?: { extensionId: string; openerId: string; width: number; height: number };
}

export interface BrowserDrawerState {
  /** Whether the drawer can show browsers (always in the app; not in the renderer's browser preview) */
  available: boolean;
  sessions: BrowserDrawerSession[];
  /** The sessions' pages, known while a drawer is open */
  pages: BrowserDrawerPage[];
  /** The sessions the bridge is connected to (their pages are known: none means no tabs) */
  connectedSessions?: string[];
  /** The chats' browsers */
  chatBrowsers?: ChatBrowserInfo[];
}

/** A frame of the viewed page: a JPEG of its viewport */
export interface BrowserDrawerFrame {
  pageId: string;
  data: Uint8Array;
  /** The page's viewport, in CSS pixels */
  width: number;
  height: number;
}

/** The CSS cursor a viewed page asks for where the mouse is (a keyword, never an image) */
export interface BrowserDrawerCursor {
  pageId: string;
  cursor: string;
}

/** The viewer's input, in the page's CSS pixels */
export type BrowserDrawerInput =
  | { kind: 'mousemove'; x: number; y: number }
  | { kind: 'mousedown' | 'mouseup'; x: number; y: number; button: 'left' | 'right' | 'middle'; clickCount: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'keydown' | 'keyup'; key: string }
  | { kind: 'text'; text: string };

export type BrowserDrawerNavigation = 'back' | 'forward' | 'reload' | 'stop' | 'goto';

/** What opening a chat browser on Windows needs that can be missing there */
export type ChatBrowserRequirement = 'node' | 'browserBuild';

/** What opening a chat browser with a profile choice needs that is missing (Windows only; empty elsewhere) */
export interface ChatBrowserRequirements {
  missing: ChatBrowserRequirement[];
  /** Playwright's own browser the choice runs, whose build is needed */
  build?: DownloadableBrowser;
  /** An autoconfigure window is open and its result is awaited */
  configuring?: boolean;
  /**
   * Chat browsers run on Windows while the shell is WSL: Playwright's availability check, made in
   * the distribution, says nothing about them (this check stands in for it)
   */
  fromWsl?: boolean;
}
