import type { CompletablePhase, ExecutionPhase } from '../../shared/constants/phase-protocol';
import type { Project, Task } from '../../shared/types';

/**
 * Agent-specific types for running tasks through Claude Code
 */

export interface ExecutionProgressData {
  phase: ExecutionPhase;
  phaseProgress: number;
  overallProgress: number;
  currentSubtask?: string;
  message?: string;
  completedPhases?: CompletablePhase[];
  /** The base branch the run is merging in (resync), null when it is not syncing */
  syncingWith?: string | null;
}

/** Kind of run that exited (kept as a type for listeners that log it) */
export type ProcessType = 'task-execution';

/** How a task run is started */
export interface StartTaskOptions {
  project: Project;
  task: Task;
  /** start: new or continued run; revise: apply reviewer feedback in the same session */
  mode: 'start' | 'revise';
  feedback?: string;
  /** Absolute paths of images attached to the feedback */
  feedbackImagePaths?: string[];
  /** Claude profile to run on (undefined = the project's account, else the account in use) */
  profileId?: string;
}

/** Details of an authentication failure, forwarded to the renderer */
export interface AgentAuthFailure {
  profileId?: string;
  failureType?: 'missing' | 'invalid' | 'expired' | 'unknown';
  message?: string;
  originalError?: string;
}