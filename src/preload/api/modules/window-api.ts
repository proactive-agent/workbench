import { IPC_CHANNELS, WINDOW_PROJECT_ARG } from '../../../shared/constants';
import type { IPCResult, ProjectWindowInfo, WindowCloseChoice, WindowCloseRequest } from '../../../shared/types';
import { createIpcListener, invokeIpc, sendIpc, type IpcListenerCleanup } from './ipc-utils';

/** Project this window was opened for, from the argument the main process set on it */
function readAssignedProjectId(): string | null {
  const arg = process.argv.find((value) => value.startsWith(WINDOW_PROJECT_ARG));
  return arg ? arg.slice(WINDOW_PROJECT_ARG.length) || null : null;
}

export interface WindowAPI {
  /**
   * Project this window was opened for, known before the first render (null for the first
   * window, which restores the project it showed last).
   */
  assignedProjectId: string | null;
  /** Every open window with the project it shows */
  listProjectWindows: () => Promise<IPCResult<ProjectWindowInfo[]>>;
  /** Tell the main process which project this window shows (tray menu, window lookups) */
  reportWindowProject: (projectId: string | null) => void;
  /** Open a project in a new window; `focused` means another window already showed it */
  openProjectWindow: (projectId: string) => Promise<IPCResult<{ focused: boolean }>>;
  /** Close the window showing a project ("Quit window") */
  closeProjectWindow: (projectId: string) => Promise<IPCResult>;
  onProjectWindowsChanged: (callback: (windows: ProjectWindowInfo[]) => void) => IpcListenerCleanup;
  /** The window's close button was pressed while the app can keep running in the background */
  onWindowCloseRequested: (callback: (request: WindowCloseRequest) => void) => IpcListenerCleanup;
  /** Answer to it: hide the window to the tray, or quit (this window, or the app when it is the last) */
  chooseWindowClose: (choice: WindowCloseChoice) => Promise<IPCResult>;
}

export const createWindowAPI = (): WindowAPI => ({
  assignedProjectId: readAssignedProjectId(),

  listProjectWindows: (): Promise<IPCResult<ProjectWindowInfo[]>> =>
    invokeIpc(IPC_CHANNELS.WINDOW_LIST_PROJECTS),

  reportWindowProject: (projectId: string | null): void =>
    sendIpc(IPC_CHANNELS.WINDOW_REPORT_PROJECT, projectId),

  openProjectWindow: (projectId: string): Promise<IPCResult<{ focused: boolean }>> =>
    invokeIpc(IPC_CHANNELS.WINDOW_OPEN_PROJECT, projectId),

  closeProjectWindow: (projectId: string): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.WINDOW_CLOSE_PROJECT, projectId),

  onProjectWindowsChanged: (callback: (windows: ProjectWindowInfo[]) => void): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.WINDOW_PROJECTS_CHANGED, (windows: ProjectWindowInfo[]) =>
      callback(windows)
    ),

  onWindowCloseRequested: (callback: (request: WindowCloseRequest) => void): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.WINDOW_CLOSE_REQUESTED, (request: WindowCloseRequest) => callback(request)),

  chooseWindowClose: (choice: WindowCloseChoice): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.WINDOW_CLOSE_CHOICE, choice)
});
