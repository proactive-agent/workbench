/**
 * MCP Server API
 *
 * Exposes MCP health check and connection test functionality to the renderer.
 */

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants/ipc';
import type { IPCResult } from '../../../shared/types/common';
import type { CustomMcpServer, McpAvailability, McpHealthCheckResult, McpTestConnectionResult } from '../../../shared/types/project';
import type { BrowserProfile, DownloadableBrowser } from '../../../shared/types/browser-profiles';

export interface McpAPI {
  /** Quick health check for a custom MCP server */
  checkMcpHealth: (server: CustomMcpServer) => Promise<IPCResult<McpHealthCheckResult>>;
  /** Full MCP connection test */
  testMcpConnection: (server: CustomMcpServer) => Promise<IPCResult<McpTestConnectionResult>>;
  /** Whether the connectors' servers can start; unknown ones start being checked */
  getMcpAvailability: (ids: string[]) => Promise<IPCResult<Record<string, McpAvailability>>>;
  /** Called when a connector's availability changes */
  onMcpAvailabilityChanged: (callback: (id: string, availability: McpAvailability) => void) => () => void;
  /** Local browser profiles for the Puppeteer connector (found when the app started) */
  detectBrowserProfiles: () => Promise<IPCResult<BrowserProfile[]>>;
  /**
   * Open a terminal that downloads a browser for Puppeteer. `alreadyRunning`: a download of it
   * started earlier still counts as running, so no terminal was opened
   */
  installPuppeteerBrowser: (browser: DownloadableBrowser) => Promise<IPCResult<{ command: string; alreadyRunning?: boolean }>>;
  /** Called with the new list when a started download finished */
  onBrowserProfilesChanged: (callback: (profiles: BrowserProfile[]) => void) => () => void;
}

export function createMcpAPI(): McpAPI {
  return {
    checkMcpHealth: (server: CustomMcpServer) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, server),

    testMcpConnection: (server: CustomMcpServer) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST_CONNECTION, server),

    getMcpAvailability: (ids: string[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_AVAILABILITY, ids),

    detectBrowserProfiles: () =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_DETECT_BROWSER_PROFILES),

    installPuppeteerBrowser: (browser: DownloadableBrowser) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_INSTALL_BROWSER, browser),

    onBrowserProfilesChanged: (callback: (profiles: BrowserProfile[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, profiles: BrowserProfile[]) => callback(profiles);
      ipcRenderer.on(IPC_CHANNELS.MCP_BROWSER_PROFILES_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.MCP_BROWSER_PROFILES_CHANGED, listener);
      };
    },

    onMcpAvailabilityChanged: (callback: (id: string, availability: McpAvailability) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: string, availability: McpAvailability) => callback(id, availability);
      ipcRenderer.on(IPC_CHANNELS.MCP_AVAILABILITY_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.MCP_AVAILABILITY_CHANGED, listener);
      };
    },
  };
}
