/**
 * Browser drawer API for the renderer: the live Playwright sessions of task runs and chats, their
 * pages, and streaming and driving one page in the drawer (src/main/browser-drawer/)
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type {
  BrowserDrawerFrame,
  BrowserDrawerInput,
  BrowserDrawerNavigation,
  BrowserDrawerState,
} from '../../../shared/types/browser-drawer';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';
import { createIpcListener, invokeIpc, sendIpc, type IpcListenerCleanup } from './ipc-utils';

export interface BrowserDrawerAPI {
  /** The live sessions and pages, and whether the drawer is available */
  getBrowserDrawerState: () => Promise<IPCResult<BrowserDrawerState>>;
  /** The window's drawer opened: the sessions' pages are tracked */
  subscribeBrowserDrawer: () => Promise<IPCResult>;
  /** The window's drawer closed */
  unsubscribeBrowserDrawer: () => Promise<IPCResult>;
  /** Stream a page (null: none) to this window, its viewport sized to width x height CSS pixels */
  viewBrowserPage: (pageId: string | null, width: number, height: number) => void;
  sendBrowserInput: (pageId: string, input: BrowserDrawerInput) => void;
  navigateBrowserPage: (pageId: string, action: BrowserDrawerNavigation, url?: string) => void;
  closeBrowserPage: (pageId: string) => void;
  /** A new tab in a session's browser */
  newBrowserPage: (sessionId: string) => void;
  /** Open a chat's own browser with this browser (undefined: Settings > Connectors) */
  openChatBrowser: (projectId: string, chatId: string, choice: PlaywrightBrowserChoice | null | undefined) => Promise<IPCResult>;
  /** Close a chat's own browser */
  closeChatBrowser: (projectId: string, chatId: string) => Promise<IPCResult>;
  /** The sessions or pages changed */
  onBrowserDrawerState: (callback: (state: BrowserDrawerState) => void) => IpcListenerCleanup;
  /** A frame of the page this window views */
  onBrowserFrame: (callback: (frame: BrowserDrawerFrame) => void) => IpcListenerCleanup;
}

export const createBrowserDrawerAPI = (): BrowserDrawerAPI => ({
  getBrowserDrawerState: () => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_GET_STATE),
  subscribeBrowserDrawer: () => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_SUBSCRIBE),
  unsubscribeBrowserDrawer: () => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_UNSUBSCRIBE),
  viewBrowserPage: (pageId, width, height) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_VIEW, pageId, width, height),
  sendBrowserInput: (pageId, input) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_INPUT, pageId, input),
  navigateBrowserPage: (pageId, action, url) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_NAVIGATE, pageId, action, url),
  closeBrowserPage: (pageId) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_CLOSE_PAGE, pageId),
  newBrowserPage: (sessionId) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_NEW_PAGE, sessionId),
  openChatBrowser: (projectId, chatId, choice) => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_OPEN_CHAT_BROWSER, projectId, chatId, choice),
  closeChatBrowser: (projectId, chatId) => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_CLOSE_CHAT_BROWSER, projectId, chatId),
  onBrowserDrawerState: (callback) => createIpcListener(IPC_CHANNELS.BROWSER_DRAWER_STATE, callback),
  onBrowserFrame: (callback) => createIpcListener(IPC_CHANNELS.BROWSER_DRAWER_FRAME, callback),
});
