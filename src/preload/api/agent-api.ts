/**
 * Agent API - Aggregates all agent-related API modules
 *
 * This file serves as the main entry point for agent APIs, combining:
 * - Insights operations
 * - Shell operations
 */

import { createInsightsAPI, InsightsAPI } from './modules/insights-api';
import { createShellAPI, ShellAPI } from './modules/shell-api';

/**
 * Combined Agent API interface
 * Includes all operations from individual API modules
 */
export interface AgentAPI extends
  InsightsAPI,
  ShellAPI {}

/**
 * Creates the complete Agent API by combining all module APIs
 *
 * @returns Complete AgentAPI with all operations available
 */
export const createAgentAPI = (): AgentAPI => {
  const insightsAPI = createInsightsAPI();
  const shellAPI = createShellAPI();

  return {
    // Insights API
    ...insightsAPI,

    // Shell Operations API
    ...shellAPI
  };
};

// Re-export individual API interfaces for consumers who need them
export type {
  InsightsAPI,
  ShellAPI
};
