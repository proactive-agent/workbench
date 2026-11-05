/**
 * Browser mock for window.electronAPI
 * This allows the app to run in a regular browser for UI development/testing
 *
 * This module aggregates all mock implementations from separate modules
 * for better code organization and maintainability.
 */

import type { ElectronAPI } from '../../shared/types';
import {
  projectMock,
  taskMock,
  workspaceMock,
  terminalMock,
  claudeProfileMock,
  insightsMock,
  infrastructureMock,
  settingsMock
} from './mocks';

// Check if we're in a browser (not Electron)
const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

/**
 * Create mock electronAPI for browser
 * Aggregates all mock implementations from separate modules
 */
const browserMockAPI: ElectronAPI = {
  // Project Operations
  ...projectMock,

  // Task Operations
  ...taskMock,

  // Workspace Management
  ...workspaceMock,

  // Terminal Operations
  ...terminalMock,

  // Claude Profile Management
  ...claudeProfileMock,

  // Settings
  ...settingsMock,

  // Insights Operations
  ...insightsMock,

  // Infrastructure & Docker Operations
  ...infrastructureMock,

  // API Profile Management (custom Anthropic-compatible endpoints)
  getAPIProfiles: async () => ({
    success: true,
    data: {
      profiles: [],
      activeProfileId: null,
      version: 1
    }
  }),

  saveAPIProfile: async (profile) => ({
    success: true,
    data: {
      id: `mock-profile-${Date.now()}`,
      ...profile,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }),

  updateAPIProfile: async (profile) => ({
    success: true,
    data: {
      ...profile,
      updatedAt: Date.now()
    }
  }),

  deleteAPIProfile: async (_profileId: string) => ({
    success: true
  }),

  setActiveAPIProfile: async (_profileId: string | null) => ({
    success: true
  }),

  testConnection: async (_baseUrl: string, _apiKey: string, _signal?: AbortSignal) => ({
    success: true,
    data: {
      success: true,
      message: 'Connection successful (mock)'
    }
  }),

  discoverModels: async (_baseUrl: string, _apiKey: string, _signal?: AbortSignal) => ({
    success: true,
    data: {
      models: []
    }
  }),

  // Queue Routing API (rate limit recovery)
  queue: {
    getRunningTasksByProfile: async () => ({ success: true, data: { byProfile: {}, totalRunning: 0 } }),
    getBestProfileForTask: async () => ({ success: true, data: null }),
    getBestUnifiedAccount: async () => ({ success: true, data: null }),
    assignProfileToTask: async () => ({ success: true }),
    updateTaskSession: async () => ({ success: true }),
    getTaskSession: async () => ({ success: true, data: null }),
    onQueueProfileSwapped: () => () => {},
    onQueueSessionCaptured: () => () => {},
    onQueueBlockedNoProfiles: () => () => {}
  },

  // Claude Code Operations
  // Graphify CLI (memory graph)
  checkGraphifyVersion: async () => ({
    success: true,
    data: { installed: null, latest: null, isOutdated: false }
  }),
  installGraphify: async () => ({ success: true, data: { command: 'uv tool install graphifyy' } }),
  getGraphifyIndex: async () => ({ success: true, data: null }),
  buildGraphifyIndex: async () => ({ success: false, error: 'Not available in browser mode' }),
  getProjectIndex: async () => ({ success: true, data: null }),
  buildProjectIndex: async () => ({ success: false, error: 'Not available in browser mode' }),
  isProjectIndexBuilding: async () => ({ success: true, data: false }),
  stashProjectIndex: async () => ({ success: false, error: 'Not available in browser mode' }),
  getMemoryIndex: async () => ({ success: true, data: null }),
  buildMemoryIndex: async () => ({ success: false, error: 'Not available in browser mode' }),
  isMemoryIndexBuilding: async () => ({ success: true, data: false }),
  hasGraphifyGraph: async () => ({ success: true, data: false }),
  isGraphifyEnabled: async () => ({ success: true, data: false }),
  setGraphifyEnabled: async () => ({ success: false, error: 'Not available in browser mode' }),
  getGraphifyGraph: async () => ({ success: true, data: null }),
  onGraphifyIndexUpdated: () => () => {},

  // Live agent (agent windows' agent-flow graph)
  getLiveAgentStatus: async () => ({ success: true, data: { state: 'stopped' as const } }),
  getLiveAgentProject: async () => ({ success: true, data: false }),
  setLiveAgentProject: async () => ({ success: false, error: 'Not available in browser mode' }),
  subscribeLiveAgent: async () => ({ success: true }),
  unsubscribeLiveAgent: async () => ({ success: true }),
  onLiveAgentStatus: () => () => {},
  onLiveAgentMessage: () => () => {},
  getBrowserDrawerState: async () => ({ success: true, data: { available: false, sessions: [], pages: [] } }),
  subscribeBrowserDrawer: async () => ({ success: true }),
  unsubscribeBrowserDrawer: async () => ({ success: true }),
  viewBrowserPage: () => {},
  sendBrowserInput: () => {},
  browserFrameDrawn: () => {},
  navigateBrowserPage: () => {},
  closeBrowserPage: () => {},
  newBrowserPage: () => {},
  setBrowserColorScheme: () => {},
  openChatBrowser: async () => ({ success: false, error: 'Not available in the browser preview' }),
  closeChatBrowser: async () => ({ success: true }),
  onBrowserDrawerState: () => () => {},
  onBrowserFrame: () => () => {},

  checkClaudeCodeVersion: async () => ({
    success: true,
    data: {
      installed: '1.0.0',
      latest: '1.0.0',
      isOutdated: false,
      path: '/usr/local/bin/claude',
      detectionResult: {
        found: true,
        version: '1.0.0',
        path: '/usr/local/bin/claude',
        source: 'system-path' as const,
        message: 'Claude Code CLI found'
      }
    }
  }),
  installClaudeCode: async () => ({
    success: true,
    data: { command: 'npm install -g @anthropic-ai/claude-code' }
  }),
  getClaudeCodeVersions: async () => ({
    success: true,
    data: {
      versions: ['1.0.5', '1.0.4', '1.0.3', '1.0.2', '1.0.1', '1.0.0']
    }
  }),
  installClaudeCodeVersion: async (version: string) => ({
    success: true,
    data: { command: `npm install -g @anthropic-ai/claude-code@${version}`, version }
  }),
  getClaudeCodeInstallations: async () => ({
    success: true,
    data: {
      installations: [
        {
          path: '/usr/local/bin/claude',
          version: '1.0.0',
          source: 'system-path' as const,
          isActive: true,
        }
      ],
      activePath: '/usr/local/bin/claude',
    }
  }),
  setClaudeCodeActivePath: async (cliPath: string) => ({
    success: true,
    data: { path: cliPath }
  }),

  // Worktree Change Detection
  checkWorktreeChanges: async () => ({
    success: true,
    data: { hasChanges: false, changedFileCount: 0 }
  }),

  // Terminal Worktree Operations
  createTerminalWorktree: async () => ({
    success: false,
    error: 'Not available in browser mode'
  }),
  listTerminalWorktrees: async () => ({
    success: true,
    data: []
  }),
  removeTerminalWorktree: async () => ({
    success: false,
    error: 'Not available in browser mode'
  }),
  listOtherWorktrees: async () => ({
    success: true,
    data: []
  }),

  // MCP Server Health Check Operations
  checkMcpHealth: async (server) => ({
    success: true,
    data: {
      serverId: server.id,
      status: 'unknown' as const,
      message: 'Health check not available in browser mode',
      checkedAt: new Date().toISOString()
    }
  }),
  testMcpConnection: async (server) => ({
    success: true,
    data: {
      serverId: server.id,
      success: false,
      message: 'Connection test not available in browser mode'
    }
  }),
  // Browser mode can't start servers; treat them as ready
  getMcpAvailability: async (ids) => ({
    success: true,
    data: Object.fromEntries(ids.map((id) => [id, { state: 'ready' as const }]))
  }),
  onMcpAvailabilityChanged: () => () => {},
  detectBrowserProfiles: async () => ({ success: true, data: [] }),
  installPlaywrightBrowser: async () => ({ success: false, error: 'Not available in browser mode' }),
  onBrowserProfilesChanged: () => () => {}
};

/**
 * Initialize browser mock if not running in Electron
 */
function initBrowserMock(): void {
  if (!isElectron) {
    console.warn('%c[Browser Mock] Initializing mock electronAPI for browser preview', 'color: #f0ad4e; font-weight: bold;');
    (window as Window & { electronAPI: ElectronAPI }).electronAPI = browserMockAPI;
  }
}

// Auto-initialize
initBrowserMock();
