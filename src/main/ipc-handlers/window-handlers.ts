/**
 * Project window handlers.
 *
 * The Projects page asks for a project to be opened in this window or a new one, focuses the
 * window a project is already open in, and closes a project's window ("Quit window"). Each
 * window also reports the project it shows, which is what the tray menu lists.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/ipc';
import type { IPCResult, ProjectWindowInfo, WindowCloseChoice } from '../../shared/types';
import { projectStore } from '../project-store';
import {
  findWindowForProject,
  focusProjectWindow,
  getWindowProject,
  listProjectWindows,
  markClosingForReal,
  setWindowProject
} from '../window-manager';
import { safeSendToRenderer } from './utils';

export interface WindowHandlerDeps {
  /** Open a new window showing the project */
  createProjectWindow: (projectId: string) => void;
}

/** Tell every window which projects are open, so project cards and menus stay in step */
export function notifyProjectWindowsChanged(): void {
  safeSendToRenderer(() => null, IPC_CHANNELS.WINDOW_PROJECTS_CHANGED, listProjectWindows());
}

/**
 * The window an IPC call came from, when it can still be read.
 *
 * A renderer that is already tearing down has no window to find, so callers treat `undefined` as
 * "could not be attributed" rather than as an error: the work an id would have scoped is simply
 * left to whatever released it before.
 */
export function senderWindowId(
  event?: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
): number | undefined {
  try {
    return event?.sender ? BrowserWindow.fromWebContents(event.sender)?.id : undefined;
  } catch {
    return undefined;
  }
}

export function registerWindowHandlers({ createProjectWindow }: WindowHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.WINDOW_LIST_PROJECTS, (): IPCResult<ProjectWindowInfo[]> => {
    return { success: true, data: listProjectWindows() };
  });

  // The window tells us which project it shows (its active project)
  ipcMain.on(IPC_CHANNELS.WINDOW_REPORT_PROJECT, (event, projectId: string | null) => {
    const windowId = senderWindowId(event);
    if (windowId === undefined) return;
    setWindowProject(windowId, typeof projectId === 'string' ? projectId : null);
  });

  // Open a project in a new window, or focus the window that already shows it — the asking
  // window included, so a list that is a moment out of date can't open the same project twice
  ipcMain.handle(IPC_CHANNELS.WINDOW_OPEN_PROJECT, (_event, projectId: string): IPCResult<{ focused: boolean }> => {
    if (!projectStore.getProject(projectId)) {
      return { success: false, error: `Project not found: ${projectId}` };
    }

    if (focusProjectWindow(projectId)) {
      return { success: true, data: { focused: true } };
    }

    createProjectWindow(projectId);
    return { success: true, data: { focused: false } };
  });

  // "Quit window": close the window showing the project (the asking window first, since a
  // project switch can leave two windows reporting it for a moment)
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE_PROJECT, (event, projectId: string): IPCResult => {
    const senderId = senderWindowId(event);
    const sender =
      senderId !== undefined && getWindowProject(senderId) === projectId
        ? BrowserWindow.fromId(senderId)
        : null;
    const window = sender ?? findWindowForProject(projectId);
    if (!window) {
      return { success: false, error: `No window open for project: ${projectId}` };
    }
    markClosingForReal(window.id);
    window.close();
    return { success: true };
  });

  // The close button's question answered (index.ts asks it while other project windows are open):
  // keep running in the background hides the window to the tray; Close project closes this window
  // (never the app: with the others closed meanwhile, the tray keeps it running)
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE_CHOICE, (event, choice: WindowCloseChoice): IPCResult => {
    const windowId = senderWindowId(event);
    const window = windowId !== undefined ? BrowserWindow.fromId(windowId) : null;
    if (!window || window.isDestroyed()) return { success: false, error: 'No window to close' };
    if (choice === 'background') {
      window.hide();
    } else {
      markClosingForReal(window.id);
      window.close();
    }
    return { success: true };
  });
}

/** Whether windows other than this one are open (closing it then leaves the app running) */
export function hasOtherWindows(windowId: number): boolean {
  return listProjectWindows().some((other) => other.windowId !== windowId);
}
