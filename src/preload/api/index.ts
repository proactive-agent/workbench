import { ProjectAPI, createProjectAPI } from './project-api';
import { TerminalAPI, createTerminalAPI } from './terminal-api';
import { TaskAPI, createTaskAPI } from './task-api';
import { SettingsAPI, createSettingsAPI } from './settings-api';
import { AgentAPI, createAgentAPI } from './agent-api';
import type { InsightsAPI } from './modules/insights-api';
import { AppUpdateAPI, createAppUpdateAPI } from './app-update-api';
import { ClaudeCodeAPI, createClaudeCodeAPI } from './modules/claude-code-api';
import { GraphifyAPI, createGraphifyAPI } from './modules/graphify-api';
import { SelfImproveAPI, createSelfImproveAPI } from './modules/self-improve-api';
import { ProjectIndexAPI, createProjectIndexAPI } from './modules/project-index-api';
import { LiveAgentAPI, createLiveAgentAPI } from './modules/live-agent-api';
import { McpAPI, createMcpAPI } from './modules/mcp-api';
import { BrowserDrawerAPI, createBrowserDrawerAPI } from './modules/browser-drawer-api';
import { ProfileAPI, createProfileAPI } from './profile-api';
import { WindowAPI, createWindowAPI } from './modules/window-api';
import { ShellRuntimeAPI, createShellRuntimeAPI } from './modules/shell-runtime-api';

export interface ElectronAPI extends
  ProjectAPI,
  TerminalAPI,
  TaskAPI,
  SettingsAPI,
  AgentAPI,
  InsightsAPI,
  AppUpdateAPI,
  ClaudeCodeAPI,
  GraphifyAPI,
  SelfImproveAPI,
  ProjectIndexAPI,
  LiveAgentAPI,
  McpAPI,
  BrowserDrawerAPI,
  ProfileAPI,
  WindowAPI,
  ShellRuntimeAPI {}

export const createElectronAPI = (): ElectronAPI => ({
  ...createProjectAPI(),
  ...createTerminalAPI(),
  ...createTaskAPI(),
  ...createSettingsAPI(),
  ...createAgentAPI(),  // Includes: Insights, Shell
  ...createAppUpdateAPI(),
  ...createClaudeCodeAPI(),
  ...createGraphifyAPI(),
  ...createSelfImproveAPI(),
  ...createProjectIndexAPI(),
  ...createLiveAgentAPI(),
  ...createMcpAPI(),
  ...createBrowserDrawerAPI(),
  ...createProfileAPI(),
  ...createWindowAPI(),
  ...createShellRuntimeAPI()
});

// Export individual API creators for potential use in tests or specialized contexts
// Note: InsightsAPI is included in AgentAPI
;

;
