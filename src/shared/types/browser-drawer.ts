/**
 * The browser drawer: the headless browsers task runs and Claude chats open with the Playwright
 * connector, shown and driven inside Workbench (src/main/browser-drawer/)
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
  /** The project whose task run or chat it belongs to */
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
  status: 'starting' | 'open';
}

/** A page (tab) of a session's browser */
export interface BrowserDrawerPage {
  id: string;
  sessionId: string;
  title: string;
  url: string;
}

export interface BrowserDrawerState {
  /** Whether the drawer can show browsers (not when Workbench runs everything in WSL) */
  available: boolean;
  /** Why it can't */
  unavailableReason?: 'wsl';
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

export type BrowserDrawerNavigation = 'back' | 'forward' | 'reload' | 'goto';
