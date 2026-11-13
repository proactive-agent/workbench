/**
 * Browser drawer API for the renderer: the live Playwright sessions of Claude chats, their
 * pages, and streaming and driving one page in the drawer (src/main/browser-drawer/)
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type {
  BrowserBookmark,
  BrowserDrawerFrame,
  BrowserDrawerInput,
  BrowserDrawerNavigation,
  BrowserDrawerState,
  BrowserExtensions,
} from '../../../shared/types/browser-drawer';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';
import type { ChatBrowserRuntimeStatus } from '../../../shared/types/settings';
import type { BrowserShortcut } from '../../../shared/utils/browser-shortcuts';
import { createIpcListener, invokeIpc, sendIpc, type IpcListenerCleanup } from './ipc-utils';

export interface BrowserDrawerAPI {
  /** The live sessions and pages, and whether the drawer is available */
  getBrowserDrawerState: () => Promise<IPCResult<BrowserDrawerState>>;
  /** The window's drawer opened: the sessions' pages are tracked */
  subscribeBrowserDrawer: () => Promise<IPCResult>;
  /** The window's drawer closed */
  unsubscribeBrowserDrawer: () => Promise<IPCResult>;
  /**
   * Stream a page (null: none) to this window, its viewport sized to width x height CSS pixels,
   * its frames at `scale` device pixels per CSS pixel (the window's devicePixelRatio)
   */
  viewBrowserPage: (pageId: string | null, width: number, height: number, scale?: number, popup?: boolean) => void;
  sendBrowserInput: (pageId: string, input: BrowserDrawerInput) => void;
  /** This window drew a frame of the page (the next frame waits for it) */
  browserFrameDrawn: (pageId: string) => void;
  navigateBrowserPage: (pageId: string, action: BrowserDrawerNavigation, url?: string) => void;
  /** The copy or cut shortcut on a page: its selected text goes on the clipboard (whether it had any) */
  copyBrowserSelection: (pageId: string) => Promise<boolean>;
  closeBrowserPage: (pageId: string) => void;
  /** A new tab in a session's browser */
  newBrowserPage: (sessionId: string) => void;
  /** The bookmarks bar of a session's browser profile (empty without one) */
  getBrowserBookmarks: (sessionId: string) => Promise<IPCResult<BrowserBookmark[]>>;
  /**
   * A chat browser's extensions (null: it runs none), after switching the ones `switches` names
   * (extension id -> on) where the browser can while it runs
   */
  getBrowserExtensions: (sessionId: string, switches?: Record<string, boolean>) => Promise<IPCResult<BrowserExtensions | null>>;
  /**
   * Click an extension's toolbar button for a page, as the browser's own does (Chromium): the id of
   * its popup when one opened (a page shown over the tab), none when its click handler ran
   */
  runBrowserExtension: (pageId: string, extensionId: string, name: string) => Promise<IPCResult<{ popupId?: string }>>;
  /** Start a chat browser again from its profile and tabs (extension switches waiting for it apply) */
  restartChatBrowser: (sessionId: string) => Promise<IPCResult>;
  /** Workbench's theme, which the chat browsers' pages get as their color scheme */
  setBrowserColorScheme: (scheme: 'light' | 'dark') => void;
  /** Open a chat's own browser with this browser (undefined: Settings > Browser) */
  openChatBrowser: (projectId: string, chatId: string, choice: PlaywrightBrowserChoice | null | undefined) => Promise<IPCResult>;
  /** Close a chat's own browser; its tabs open again next time unless `keepTabs` is false */
  closeChatBrowser: (projectId: string, chatId: string, keepTabs?: boolean) => Promise<IPCResult>;
  /** The sessions or pages changed */
  onBrowserDrawerState: (callback: (state: BrowserDrawerState) => void) => IpcListenerCleanup;
  /** A frame of the page this window views */
  onBrowserFrame: (callback: (frame: BrowserDrawerFrame) => void) => IpcListenerCleanup;
  /** Windows: where chat browsers run and what running them on Windows needs (`refresh`: checked again) */
  getChatBrowserRuntimeStatus: (refresh?: boolean) => Promise<IPCResult<ChatBrowserRuntimeStatus>>;
  /** Windows: a PowerShell window installs what running chat browsers on Windows needs */
  autoconfigureChatBrowserRuntime: () => Promise<IPCResult<ChatBrowserRuntimeStatus>>;
  /** The status changed (an autoconfigure window closed) */
  onChatBrowserRuntimeStatus: (callback: (status: ChatBrowserRuntimeStatus) => void) => IpcListenerCleanup;
  /** This window's drawer is open with tabs: the browser's shortcuts go to it (or no longer) */
  setBrowserShortcuts: (active: boolean) => void;
  /** A browser shortcut was pressed while they go to this window's drawer */
  onBrowserShortcut: (callback: (shortcut: BrowserShortcut) => void) => IpcListenerCleanup;
}

export const createBrowserDrawerAPI = (): BrowserDrawerAPI => ({
  getBrowserDrawerState: () => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_GET_STATE),
  subscribeBrowserDrawer: () => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_SUBSCRIBE),
  unsubscribeBrowserDrawer: () => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_UNSUBSCRIBE),
  viewBrowserPage: (pageId, width, height, scale, popup) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_VIEW, pageId, width, height, scale, popup),
  sendBrowserInput: (pageId, input) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_INPUT, pageId, input),
  browserFrameDrawn: (pageId) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_FRAME_DRAWN, pageId),
  navigateBrowserPage: (pageId, action, url) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_NAVIGATE, pageId, action, url),
  copyBrowserSelection: (pageId) => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_COPY, pageId),
  closeBrowserPage: (pageId) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_CLOSE_PAGE, pageId),
  newBrowserPage: (sessionId) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_NEW_PAGE, sessionId),
  getBrowserBookmarks: (sessionId) => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_BOOKMARKS, sessionId),
  getBrowserExtensions: (sessionId, switches) => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_EXTENSIONS, sessionId, switches),
  runBrowserExtension: (pageId, extensionId, name) => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_EXTENSION_ACTION, pageId, extensionId, name),
  restartChatBrowser: (sessionId) => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_RESTART_CHAT_BROWSER, sessionId),
  setBrowserColorScheme: (scheme) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_COLOR_SCHEME, scheme),
  openChatBrowser: (projectId, chatId, choice) => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_OPEN_CHAT_BROWSER, projectId, chatId, choice),
  closeChatBrowser: (projectId, chatId, keepTabs) => invokeIpc(IPC_CHANNELS.BROWSER_DRAWER_CLOSE_CHAT_BROWSER, projectId, chatId, keepTabs),
  onBrowserDrawerState: (callback) => createIpcListener(IPC_CHANNELS.BROWSER_DRAWER_STATE, callback),
  onBrowserFrame: (callback) => createIpcListener(IPC_CHANNELS.BROWSER_DRAWER_FRAME, callback),
  getChatBrowserRuntimeStatus: (refresh) => invokeIpc(IPC_CHANNELS.BROWSER_RUNTIME_STATUS, refresh === true),
  autoconfigureChatBrowserRuntime: () => invokeIpc(IPC_CHANNELS.BROWSER_RUNTIME_AUTOCONFIGURE),
  onChatBrowserRuntimeStatus: (callback) => createIpcListener(IPC_CHANNELS.BROWSER_RUNTIME_STATUS_CHANGED, callback),
  setBrowserShortcuts: (active) => sendIpc(IPC_CHANNELS.BROWSER_DRAWER_SHORTCUTS, active),
  onBrowserShortcut: (callback) => createIpcListener(IPC_CHANNELS.BROWSER_DRAWER_SHORTCUT, callback),
});
