/**
 * IPC Handlers Module Index
 *
 * This module exports a single setup function that registers all IPC handlers
 * organized by domain into separate handler modules.
 */

import type { BrowserWindow } from 'electron';
import { AgentManager } from '../agent';
import { TerminalManager } from '../terminal-manager';

// Import all handler registration functions
import { registerProjectHandlers } from './project-handlers';
import { registerTaskHandlers } from './task-handlers';
import { registerTerminalHandlers } from './terminal-handlers';
import { registerAgenteventsHandlers } from './agent-events-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { registerInsightsHandlers } from './insights-handlers';
import { registerAppUpdateHandlers } from './app-update-handlers';
import { registerClaudeCodeHandlers } from './claude-code-handlers';
import { registerGraphifyHandlers } from './graphify-handlers';
import { registerSelfImproveHandlers } from './self-improve-handlers';
import { registerProjectIndexHandlers } from './project-index-handlers';
import { registerLiveAgentHandlers } from './live-agent-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { registerBrowserDrawerHandlers } from './browser-drawer-handlers';
import { registerProfileHandlers } from './profile-handlers';
import { registerShellRuntimeHandlers } from './shell-runtime-handlers';
import { registerWindowHandlers, type WindowHandlerDeps } from './window-handlers';
import { registerTerminalWorktreeIpcHandlers } from './terminal';
import { notificationService } from '../notification-service';
import { setAgentManagerRef } from './utils';

/**
 * Setup all IPC handlers across all domains
 *
 * @param agentManager - The agent manager instance
 * @param terminalManager - The terminal manager instance
 * @param getMainWindow - Function to get the window in use
 * @param windowDeps - How to open a project's own window (project windows)
 */
export function setupIpcHandlers(
  agentManager: AgentManager,
  terminalManager: TerminalManager,
  getMainWindow: () => BrowserWindow | null,
  windowDeps: WindowHandlerDeps
): void {
  // Initialize notification service
  notificationService.initialize(getMainWindow);

  // Wire up agent manager for circuit breaker cleanup
  setAgentManagerRef(agentManager);

  // Project handlers
  registerProjectHandlers(getMainWindow);

  // Project windows (open a project in its own window, focus or close one)
  registerWindowHandlers(windowDeps);

  // Task handlers
  registerTaskHandlers(agentManager, getMainWindow);

  // Terminal and Claude profile handlers
  registerTerminalHandlers(terminalManager, getMainWindow, agentManager);

  // Terminal worktree handlers (isolated development in worktrees)
  registerTerminalWorktreeIpcHandlers();

  // Agent event handlers (event forwarding from agent manager to renderer)
  registerAgenteventsHandlers(agentManager, getMainWindow);

  // Settings and dialog handlers
  registerSettingsHandlers(agentManager, getMainWindow);

  // Insights handlers
  registerInsightsHandlers(getMainWindow);

  // App auto-update handlers
  registerAppUpdateHandlers();

  // Claude Code CLI handlers (version checking, installation)
  registerClaudeCodeHandlers();

  // Graphify CLI handlers (version, installation, project memory graph)
  registerGraphifyHandlers();
  registerSelfImproveHandlers();
  registerProjectIndexHandlers();

  // Live agent handlers (relay status, agent windows' graph subscriptions)
  registerLiveAgentHandlers();

  // MCP server health check handlers
  registerMcpHandlers();
  registerBrowserDrawerHandlers();

  // API Profile handlers (custom Anthropic-compatible endpoints)
  registerProfileHandlers();

  // Windows shell setting (runtime status, WSL availability, relaunch to apply)
  registerShellRuntimeHandlers();

  console.warn('[IPC] All handler modules registered successfully');
}

// Re-export all individual registration functions for potential custom usage
;
