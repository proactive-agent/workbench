/**
 * Browser drawer IPC handlers: the live Playwright sessions and their pages, streaming a page to
 * the drawer and the drawer's input (see browser-drawer/browser-drawer-service.ts)
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { BrowserBookmark, BrowserDrawerNavigation, BrowserDrawerState } from '../../shared/types/browser-drawer';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { appLog } from '../app-logger';
import { browserDrawer } from '../browser-drawer';

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
  ipcMain.on(IPC_CHANNELS.BROWSER_DRAWER_VIEW, (event, pageId: unknown, width: unknown, height: unknown, scale: unknown) => {
    browserDrawer.view(event.sender, typeof pageId === 'string' ? pageId : null, width, height, scale);
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
