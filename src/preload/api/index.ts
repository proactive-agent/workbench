import { ProjectAPI, createProjectAPI } from './project-api';
import { TerminalAPI, createTerminalAPI } from './terminal-api';
import { TaskAPI, createTaskAPI } from './task-api';
import { SettingsAPI, createSettingsAPI } from './settings-api';
import { FileAPI, createFileAPI } from './file-api';
import { AgentAPI, createAgentAPI } from './agent-api';
import type { InsightsAPI } from './modules/insights-api';
import { AppUpdateAPI, createAppUpdateAPI } from './app-update-api';
import { DebugAPI, createDebugAPI } from './modules/debug-api';
import { ClaudeCodeAPI, createClaudeCodeAPI } from './modules/claude-code-api';
import { McpAPI, createMcpAPI } from './modules/mcp-api';
import { ProfileAPI, createProfileAPI } from './profile-api';
import { QueueAPI, createQueueAPI } from './queue-api';

export interface ElectronAPI extends
  ProjectAPI,
  TerminalAPI,
  TaskAPI,
  SettingsAPI,
  FileAPI,
  AgentAPI,
  InsightsAPI,
  AppUpdateAPI,
  DebugAPI,
  ClaudeCodeAPI,
  McpAPI,
  ProfileAPI {
  /** Queue routing API for rate limit recovery */
  queue: QueueAPI;
}

export const createElectronAPI = (): ElectronAPI => ({
  ...createProjectAPI(),
  ...createTerminalAPI(),
  ...createTaskAPI(),
  ...createSettingsAPI(),
  ...createFileAPI(),
  ...createAgentAPI(),  // Includes: Insights, Shell
  ...createAppUpdateAPI(),
  ...createDebugAPI(),
  ...createClaudeCodeAPI(),
  ...createMcpAPI(),
  ...createProfileAPI(),
  queue: createQueueAPI()  // Queue routing for rate limit recovery
});

// Export individual API creators for potential use in tests or specialized contexts
// Note: InsightsAPI is included in AgentAPI
export {
  createProjectAPI,
  createTerminalAPI,
  createTaskAPI,
  createSettingsAPI,
  createFileAPI,
  createAgentAPI,
  createAppUpdateAPI,
  createProfileAPI,
  createDebugAPI,
  createClaudeCodeAPI,
  createMcpAPI,
  createQueueAPI
};

export type {
  ProjectAPI,
  TerminalAPI,
  TaskAPI,
  SettingsAPI,
  FileAPI,
  AgentAPI,
  InsightsAPI,
  AppUpdateAPI,
  ProfileAPI,
  DebugAPI,
  ClaudeCodeAPI,
  McpAPI,
  QueueAPI
};
