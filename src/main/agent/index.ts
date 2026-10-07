/**
 * Agent module - modular agent management system
 *
 * This module provides a clean separation of concerns for agent process management:
 * - AgentManager: Main facade for orchestrating agent lifecycle
 * - AgentState: Process tracking and state management
 * - AgentEvents: Event handling and progress parsing
 * - AgentProcessManager: Process spawning and lifecycle
 */

export { AgentManager } from './agent-manager';
export { AgentState } from './agent-state';
export { AgentEvents } from './agent-events';
export { AgentProcessManager } from './agent-process';

export type {
  AgentProcess,
  ExecutionProgressData,
  ProcessType,
  AgentManagerEvents,
  TaskExecutionOptions,
  SpecCreationMetadata
} from './types';

