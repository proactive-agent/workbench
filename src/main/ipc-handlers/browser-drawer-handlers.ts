/**
 * Browser drawer IPC handlers: the live Playwright sessions and their pages, streaming a page to
 * the drawer and the drawer's input (see browser-drawer/browser-drawer-service.ts)
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { BrowserBookmark, BrowserDrawerNavigation, BrowserDrawerState, BrowserExtensions } from '../../shared/types/browser-drawer';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import type { ChatBrowserRuntimeStatus } from '../../shared/types/settings';
import { appLog } from '../app-logger';
import { browserDrawer } from '../browser-drawer';
import { autoconfigureChatBrowserRuntime, getChatBrowserRuntimeStatus, onChatBrowserRuntimeStatus } from '../browser-drawer/browser-runtime';
import { getAllWindows } from '../window-manager';
import { isMacOS } from '../platform';
import { actsWhileHeld, browserShortcut } from '../../shared/utils/browser-shortcuts';

/** Windows whose drawer is open with tabs: their browser shortcuts are caught */
const shortcutWindows = new Set<number>();
/** Windows whose keys are watched for them (once each) */
const watchedForShortcuts = new Set<number>();

export function registerBrowserDrawerHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.BROWSER_DRAWER_GET_STATE, (): IPCResult<BrowserDrawerState> => ({
    success: true,
    data: browserDrawer.getState(),
  }));

  ipcMain.handle(IPC_CHANNELS.BROWSER_DRAWER_SUBSCRIBE, async (event): Promise<IPCResult> => {
    try {
      await browserDrawer.subscribe(event.sender);
      return { success: true };
    } catch (error) {
      appLog.error('[BrowserDrawer] Could not start the browser bridge:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_DRAWER_UNSUBSCRIBE, (event): IPCResult => {
    browserDrawer.unsubscribe(event.sender.id);
    return { success: true };
  });

  // Frequent calls (resizes, input): one-way messages
  ipcMain.on(IPC_CHANNELS.BROWSER_DRAWER_VIEW, (event, pageId: unknown, width: unknown, height: unknown, scale: unknown, popup: unknown) => {
    browserDrawer.view(event.sender, typeof pageId === 'string' ? pageId : null, width, height, scale, popup);
  });

  ipcMain.on(IPC_CHANNELS.BROWSER_DRAWER_COLOR_SCHEME, (_event, scheme: unknown) => {
    browserDrawer.setColorScheme(scheme);
  });

  ipcMain.on(IPC_CHANNELS.BROWSER_DRAWER_INPUT, (_event, pageId: unknown, input: unknown) => {
    if (typeof pageId === 'string') browserDrawer.input(pageId, input);
  });

  ipcMain.on(IPC_CHANNELS.BROWSER_DRAWER_FRAME_DRAWN, (_event, pageId: unknown) => {
    if (typeof pageId === 'string') browserDrawer.frameDrawn(pageId);
  });

  ipcMain.on(IPC_CHANNELS.BROWSER_DRAWER_NAVIGATE, (_event, pageId: unknown, action: unknown, url: unknown) => {
    if (typeof pageId !== 'string' || typeof action !== 'string') return;
    browserDrawer.navigate(pageId, action as BrowserDrawerNavigation, typeof url === 'string' ? url : undefined);
  });

  ipcMain.on(IPC_CHANNELS.BROWSER_DRAWER_CLOSE_PAGE, (_event, pageId: unknown) => {
    if (typeof pageId === 'string') browserDrawer.closePage(pageId);
  });

  // Handled at once (no await before the bridge is asked): the shortcut's keys, sent right after,
  // must reach the page after its selection was read
  ipcMain.handle(IPC_CHANNELS.BROWSER_DRAWER_COPY, (_event, pageId: unknown): Promise<boolean> =>
    typeof pageId === 'string' ? browserDrawer.copySelection(pageId).catch(() => false) : Promise.resolve(false));

  ipcMain.on(IPC_CHANNELS.BROWSER_DRAWER_NEW_PAGE, (_event, sessionId: unknown) => {
    if (typeof sessionId === 'string') browserDrawer.newPage(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_DRAWER_BOOKMARKS, async (_event, sessionId: unknown): Promise<IPCResult<BrowserBookmark[]>> => {
    if (typeof sessionId !== 'string') return { success: false, error: 'Invalid browser' };
    try {
      return { success: true, data: await browserDrawer.bookmarks(sessionId) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.BROWSER_DRAWER_EXTENSIONS,
    async (_event, sessionId: unknown, switches: unknown): Promise<IPCResult<BrowserExtensions | null>> => {
      if (typeof sessionId !== 'string') return { success: false, error: 'Invalid browser' };
      try {
        return { success: true, data: await browserDrawer.extensions(sessionId, toSwitches(switches)) };
      } catch (error) {
        appLog.warn('[BrowserDrawer] Could not list a chat browser\'s extensions:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.BROWSER_DRAWER_EXTENSION_ACTION,
    async (_event, pageId: unknown, extensionId: unknown, name: unknown): Promise<IPCResult<{ popupId?: string }>> => {
      if (typeof pageId !== 'string' || typeof extensionId !== 'string') return { success: false, error: 'Invalid extension' };
      try {
        const popupId = await browserDrawer.extensionAction(pageId, extensionId, typeof name === 'string' ? name : '');
        return { success: true, data: popupId ? { popupId } : {} };
      } catch (error) {
        appLog.info('[BrowserDrawer] Could not open an extension:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.BROWSER_DRAWER_RESTART_CHAT_BROWSER, async (_event, sessionId: unknown): Promise<IPCResult> => {
    if (typeof sessionId !== 'string') return { success: false, error: 'Invalid browser' };
    try {
      await browserDrawer.restartChatBrowser(sessionId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.BROWSER_DRAWER_OPEN_CHAT_BROWSER,
    async (_event, projectId: unknown, chatId: unknown, choice: unknown): Promise<IPCResult> => {
      if (typeof projectId !== 'string' || typeof chatId !== 'string') return { success: false, error: 'Invalid chat' };
      try {
        await browserDrawer.openChatBrowser(projectId, chatId, toBrowserChoice(choice));
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.BROWSER_DRAWER_CLOSE_CHAT_BROWSER, async (_event, projectId: unknown, chatId: unknown): Promise<IPCResult> => {
    if (typeof projectId === 'string' && typeof chatId === 'string') await browserDrawer.closeChatBrowser(projectId, chatId);
    return { success: true };
  });

  // Settings > Browser > Browser runtime (Windows): where chat browsers run, what running them on
  // Windows needs (`refresh` checks again), and its Autoconfigure button
  ipcMain.handle(IPC_CHANNELS.BROWSER_RUNTIME_STATUS, async (_event, refresh: unknown): Promise<IPCResult<ChatBrowserRuntimeStatus>> => {
    try {
      return { success: true, data: await getChatBrowserRuntimeStatus({ refresh: refresh === true }) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_RUNTIME_AUTOCONFIGURE, async (): Promise<IPCResult<ChatBrowserRuntimeStatus>> => {
    try {
      return { success: true, data: await autoconfigureChatBrowserRuntime() };
    } catch (error) {
      appLog.error('[BrowserDrawer] Autoconfigure failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // While a window's drawer is open with tabs, the browser's own shortcuts (Ctrl+T, Ctrl+W,
  // Ctrl+Tab...) are caught before the page and the app's menu, and the drawer acts on them
  ipcMain.on(IPC_CHANNELS.BROWSER_DRAWER_SHORTCUTS, (event, active: unknown) => {
    const contents = event.sender;
    if (active === true) shortcutWindows.add(contents.id);
    else shortcutWindows.delete(contents.id);
    if (watchedForShortcuts.has(contents.id)) return;
    watchedForShortcuts.add(contents.id);
    // Keys caught on their way down whose release the page mustn't get either
    const caught = new Set<string>();
    contents.on('before-input-event', (inputEvent, input) => {
      if (input.type === 'keyUp') {
        if (caught.delete(input.code)) inputEvent.preventDefault();
        return;
      }
      if (input.type !== 'keyDown' || !shortcutWindows.has(contents.id)) return;
      const shortcut = browserShortcut(input, isMacOS());
      if (!shortcut) return;
      inputEvent.preventDefault();
      caught.add(input.code);
      // A held key's repeats are only swallowed, unless the shortcut goes on (switching tabs)
      if (input.isAutoRepeat && !actsWhileHeld(shortcut)) return;
      contents.send(IPC_CHANNELS.BROWSER_DRAWER_SHORTCUT, shortcut);
    });
    // The page reloaded or crashed: its drawer is gone until it says so again
    const forget = () => shortcutWindows.delete(contents.id);
    contents.on('did-navigate', forget);
    contents.on('render-process-gone', forget);
    contents.once('destroyed', () => {
      shortcutWindows.delete(contents.id);
      watchedForShortcuts.delete(contents.id);
    });
  });

  onChatBrowserRuntimeStatus((status) => {
    for (const window of getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.BROWSER_RUNTIME_STATUS_CHANGED, status);
    }
  });
}

/** Extension switches from the renderer: extension id -> on */
function toSwitches(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** A browser choice from the renderer (undefined: Settings; null: Playwright's own Chromium) */
function toBrowserChoice(value: unknown): PlaywrightBrowserChoice | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const choice = value as Partial<PlaywrightBrowserChoice>;
  return typeof choice.id === 'string' && typeof choice.engine === 'string' && typeof choice.executablePath === 'string'
    ? (value as PlaywrightBrowserChoice)
    : undefined;
}
