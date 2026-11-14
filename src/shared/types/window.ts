/**
 * Project windows: the app can show several projects at once, one project per window.
 */

/** One open app window and the project it currently shows */
export interface ProjectWindowInfo {
  /** Electron window id (stable while the window lives) */
  windowId: number;
  /** Project the window shows, or null while it shows none (welcome screen) */
  projectId: string | null;
}

/** Hide the window to the tray, or quit (this window, or the app when it is the last one) */
export type WindowCloseChoice = 'background' | 'quit';
