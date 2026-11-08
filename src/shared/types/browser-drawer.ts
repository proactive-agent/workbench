/**
 * The browser drawer: the headless browsers Claude chats open with the Playwright connector, shown
 * and driven inside Workbench (src/main/browser-drawer/). Task runs' browsers stay headless and unseen
 */

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
  /** restorable: it closed when Workbench stopped unexpectedly; opening it brings back its sign-ins and tabs */
  status: 'starting' | 'open' | 'restorable';
  /** A restorable browser's tabs that open again */
  tabs?: number;
}

/** A page (tab) of a session's browser */
export interface BrowserDrawerPage {
  id: string;
  sessionId: string;
  title: string;
  url: string;
  /** A navigation of the page is loading (from its request until the page's load event) */
  loading?: boolean;
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

/** The viewer's input, in the page's CSS pixels */
export type BrowserDrawerInput =
  | { kind: 'mousemove'; x: number; y: number }
  | { kind: 'mousedown' | 'mouseup'; x: number; y: number; button: 'left' | 'right' | 'middle'; clickCount: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'keydown' | 'keyup'; key: string }
  | { kind: 'text'; text: string };

export type BrowserDrawerNavigation = 'back' | 'forward' | 'reload' | 'stop' | 'goto';
