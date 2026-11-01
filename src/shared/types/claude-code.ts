/**
 * Claude Code task execution types
 *
 * Every task is delegated to the Claude Code CLI (`claude -p`) running in the task's git
 * worktree. A short triage run picks the model, effort and whether to plan first; then
 * Claude Code plans (optional), implements and validates in one resumable session.
 */

/** Model aliases accepted by `claude --model` */
export type ClaudeModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable';

/** Effort levels accepted by `claude --effort` */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const CLAUDE_MODEL_ALIASES: readonly ClaudeModelAlias[] = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** How a task's model and effort are chosen */
export type TriageMode = 'auto' | 'fixed';

/** Whether a task is planned (Claude Code plan mode) before it is implemented */
export type PlanningPolicy = 'auto' | 'always' | 'never';

/**
 * Claude Code dynamic workflows for large tasks: `off` disables them for task runs, the others are
 * Claude Code's `workflowSizeGuideline` (small < 5 agents, medium < 10, large < 50, unrestricted)
 */
export type WorkflowSize = 'off' | 'small' | 'medium' | 'large' | 'unrestricted';

export const WORKFLOW_SIZES: readonly WorkflowSize[] = ['off', 'small', 'medium', 'large', 'unrestricted'] as const;

/** App-wide defaults for running tasks with Claude Code (Settings > Claude Code) */
export interface ClaudeCodeTaskSettings {
  /** auto: a triage run assesses each task; fixed: always use fixedModel/fixedEffort */
  triage: TriageMode;
  /** Model used when triage is fixed, or when triage fails */
  fixedModel: ClaudeModelAlias;
  /** Effort used when triage is fixed, or when triage fails */
  fixedEffort: ClaudeEffort;
  /** Model used for the triage run itself */
  triageModel: ClaudeModelAlias;
  /** auto: follow triage; always / never: override it */
  planning: PlanningPolicy;
  /** Run checks and a fresh-context review of the diff after implementing */
  validation: boolean;
  /** Let triage pick Fable for the hardest tasks (Fable may bill to usage credits) */
  allowFable: boolean;
  /** Fallback model chain when the chosen model is overloaded (`--fallback-model`) */
  fallbackModel?: string;
  /**
   * Parallel tasks message each other (Workbench's `message_task` and `list_parallel_tasks`
   * tools) and get Workbench's notices about each other (started, overlapping files, finished,
   * merged)
   */
  taskMessaging: boolean;
  /**
   * Workflows (many subagents run from a script) for tasks triage sizes as large: a checked
   * multi-angle review at validation, and optionally the implementation. The size is the guideline
   * Claude Code gives Claude (`workflowSizeGuideline`); `off` disables workflows in task runs
   */
  workflowSize: WorkflowSize;
  /** Most workflow agents a task runs at once (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`); unset = Claude Code's default */
  workflowMaxConcurrentAgents?: number;
}

export const DEFAULT_CLAUDE_CODE_TASK_SETTINGS: ClaudeCodeTaskSettings = {
  triage: 'auto',
  fixedModel: 'sonnet',
  fixedEffort: 'medium',
  triageModel: 'sonnet',
  planning: 'auto',
  validation: true,
  allowFable: false,
  taskMessaging: true,
  workflowSize: 'medium',
};

/** Size of a task as judged by triage */
export type TaskScope = 'trivial' | 'small' | 'medium' | 'large';

/** Triage decision for a task */
export interface TaskTriage {
  model: ClaudeModelAlias;
  effort: ClaudeEffort;
  needsPlan: boolean;
  scope: TaskScope;
  /** Short task title (sentence case, no trailing period) */
  title: string;
  /** One or two sentences on why this model, effort and plan decision fit */
  reasoning: string;
  /** Commands or checks that can verify the change (tests, typecheck, build, ...) */
  verification: string[];
  /** auto: decided by the triage run; fixed: from settings; fallback: triage failed */
  source: 'auto' | 'fixed' | 'fallback';
}

/**
 * Steps of a task run. `resync`: the task's base branch moved on (another task was merged into it)
 * and the task's session merges it in, then resumes its work (`task-resync/`)
 */
export type ClaudeRunPhaseName = 'triage' | 'plan' | 'implement' | 'validate' | 'revise' | 'resync';

export interface ClaudeRunPhase {
  name: ClaudeRunPhaseName;
  model?: string;
  effort?: ClaudeEffort;
  permissionMode?: string;
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  isError?: boolean;
  error?: string;
  /** resync: what was merged in, and whether the step also carried on with unfinished work */
  resync?: { ref: string; into: string; continued: boolean };
}

/** What Claude Code loaded for the session (from the stream's `system/init` event) */
interface ClaudeRunInit {
  claudeCodeVersion?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  tools: string[];
  agents: string[];
  skills: string[];
  slashCommands: string[];
  mcpServers: { name: string; status: string }[];
  plugins: string[];
}

/** A subagent or background task Claude Code started during the run */
interface ClaudeRunSubagent {
  id: string;
  description: string;
  type?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  endedAt?: string;
}

/** A Claude Code workflow run a task's session launched (the Workflow tool) */
export interface ClaudeRunWorkflow {
  /** The run's id (`wf_...`), which a relaunch passes as `resumeFromRunId` */
  runId: string;
  /** The Workflow tool call that launched it */
  toolUseId?: string;
  /** Claude Code's background task id for the run (matches its `task_notification`) */
  taskId?: string;
  /** The workflow's name (its script's `meta.name`), when known */
  name?: string;
  /** The run's persisted script, which a relaunch can pass back as `scriptPath` */
  scriptPath?: string;
  /** The step that launched it */
  phase: ClaudeRunPhaseName;
  /** Session that launched it: a run can only be resumed in that session */
  sessionId?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  endedAt?: string;
}

interface ValidationCheck {
  name: string;
  command?: string;
  passed: boolean;
  details?: string;
}

interface ValidationFinding {
  severity: 'critical' | 'major' | 'minor';
  description: string;
  fixed: boolean;
}

/** Structured result of the validation step */
export interface ValidationReport {
  status: 'passed' | 'failed' | 'partial';
  summary: string;
  checks: ValidationCheck[];
  findings: ValidationFinding[];
}

/** Where Claude Code ran: natively on the host OS, or inside WSL (Windows, wsl shell) */
export type ClaudeRuntime = 'native' | 'wsl';

/** Persisted run state of a task (`<specDir>/claude_run.json`) */
export interface ClaudeRunInfo {
  /** Claude Code session that holds the task's conversation (resumable) */
  sessionId?: string;
  /**
   * Claude profile the session ran on. Its transcript lives in that profile's config dir, so
   * resuming the session (e.g. from an agent window) must use the same profile.
   */
  profileId?: string;
  /** Claude config dir of that profile (where the session transcript is stored), as a host path */
  configDir?: string;
  /**
   * Where the session ran (unset = native). A session can't be resumed in the other runtime (its
   * transcript lives in that runtime's config dir, under that runtime's project path), so a
   * change of runtime starts a new session.
   */
  runtime?: ClaudeRuntime;
  triage?: TaskTriage;
  /** Approved plan (Markdown), when the task was planned */
  plan?: string;
  phases: ClaudeRunPhase[];
  init?: ClaudeRunInit;
  validation?: ValidationReport;
  /** Final summary Claude wrote for the user */
  summary?: string;
  subagents: ClaudeRunSubagent[];
  /** Workflow runs the session launched (missing in runs saved before workflows were tracked) */
  workflows?: ClaudeRunWorkflow[];
  totalCostUsd: number;
  /** Absolute path of the worktree the session runs in */
  worktreePath?: string;
  updatedAt: string;
}

