/**
 * Task-related types
 */

import type { ThinkingLevel } from './settings';
import type { ExecutionPhase as ExecutionPhaseType, CompletablePhase } from '../constants/phase-protocol';
import type { ClaudeRunInfo, ClaudeRunPhase } from './claude-code';
import type { PuppeteerBrowserChoice } from './browser-profiles';

export type TaskStatus = 'backlog' | 'queue' | 'in_progress' | 'ai_review' | 'human_review' | 'done' | 'pr_created' | 'error';

// Maps task status columns to ordered task IDs for kanban board reordering
export type TaskOrderState = Record<TaskStatus, string[]>;

// Reason why a task is in human_review status
// - 'completed': All subtasks done and QA passed, ready for final approval/merge
// - 'errors': Subtasks failed during execution
// - 'qa_rejected': QA found issues that need fixing
export type ReviewReason = 'completed' | 'errors' | 'qa_rejected' | 'stopped';

export type SubtaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

// Re-exported from constants - single source of truth
export type ExecutionPhase = ExecutionPhaseType;

export interface ExecutionProgress {
  phase: ExecutionPhase;
  phaseProgress: number;  // 0-100 within current phase
  overallProgress: number;  // 0-100 overall
  currentSubtask?: string;  // Current subtask being processed
  message?: string;  // Current status message
  startedAt?: Date;
  sequenceNumber?: number;  // Monotonically increasing counter to detect stale updates
  // FIX (ACS-203): Track completed phases to prevent phase overlaps
  // When a phase completes, it's added to this array before transitioning to the next phase
  // This ensures that planning is marked complete before coding starts, etc.
  completedPhases?: CompletablePhase[];  // Phases that have successfully completed
  /** The base branch the run is merging in after another task was merged into it (null: not syncing) */
  syncingWith?: string | null;
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
  status: SubtaskStatus;
  files: string[];
  verification?: {
    type: 'command' | 'browser';
    run?: string;
    scenario?: string;
  };
}

interface QAReport {
  status: 'passed' | 'failed' | 'pending';
  issues: QAIssue[];
  timestamp: Date;
}

interface QAIssue {
  id: string;
  severity: 'critical' | 'major' | 'minor';
  description: string;
  file?: string;
  line?: number;
}

// Task Log Types - for persistent, phase-based logging
export type TaskLogPhase = 'planning' | 'coding' | 'validation';
/** `stopped`: the run was stopped (Stop, app quit) before the step finished; not a failure */
export type TaskLogPhaseStatus = 'pending' | 'active' | 'completed' | 'failed' | 'stopped';
export type TaskLogEntryType = 'text' | 'tool_start' | 'tool_end' | 'phase_start' | 'phase_end' | 'error' | 'success' | 'info';

export interface TaskLogEntry {
  timestamp: string;
  type: TaskLogEntryType;
  content: string;
  phase: TaskLogPhase;
  tool_name?: string;
  tool_input?: string;
  /** Claude Code tool call id: pairs a tool_start with its tool_end (newer logs only) */
  tool_use_id?: string;
  subtask_id?: string;
  session?: number;
  // Fields for expandable detail view
  detail?: string;  // Full content that can be expanded (e.g., file contents, command output)
  subphase?: string;  // Subphase grouping (e.g., "PROJECT DISCOVERY", "CONTEXT GATHERING")
  collapsed?: boolean;  // Whether to show collapsed by default in UI
}

export interface TaskPhaseLog {
  phase: TaskLogPhase;
  status: TaskLogPhaseStatus;
  started_at: string | null;
  completed_at: string | null;
  entries: TaskLogEntry[];
}

export interface TaskLogs {
  spec_id: string;
  created_at: string;
  updated_at: string;
  phases: {
    planning: TaskPhaseLog;
    coding: TaskPhaseLog;
    validation: TaskPhaseLog;
  };
}

/**
 * A run of a task that was thrown away when the task was started over. Its logs and the steps
 * of its Claude Code run are kept so the task dialog can still show what happened.
 */
export interface ArchivedTaskRun {
  /** Position in the task's history, oldest first, starting at 1 */
  index: number;
  /** When the run was put aside (ISO) */
  archivedAt: string;
  logs: TaskLogs | null;
  /** The run's steps (triage, plan, implement, revise, validate) with their time and cost */
  phases: ClaudeRunPhase[];
  totalCostUsd?: number;
}

// Streaming markers from Python (similar to InsightsStreamChunk)
export interface TaskLogStreamChunk {
  type: 'text' | 'tool_start' | 'tool_end' | 'phase_start' | 'phase_end' | 'error';
  content?: string;
  phase?: TaskLogPhase;
  timestamp?: string;
  tool?: {
    name: string;
    input?: string;
    success?: boolean;
  };
  subtask_id?: string;
}

// Image attachment types for task creation
export interface ImageAttachment {
  id: string;           // Unique identifier (UUID)
  filename: string;     // Original filename
  mimeType: string;     // e.g., 'image/png'
  size: number;         // Size in bytes
  data?: string;        // Base64 data (for transport)
  path?: string;        // Relative path after storage
  thumbnail?: string;   // Base64 thumbnail for preview
}

// Draft state for task creation (auto-saved when dialog closes)
export interface TaskDraft {
  projectId: string;
  title: string;
  description: string;
  images: ImageAttachment[];
  mcpConnectors?: string[];
  /** The Puppeteer connector's browser profile picked for the task (see TaskMetadata.puppeteerBrowser) */
  puppeteerBrowser?: PuppeteerBrowserChoice | null;
  pushNewBranches?: boolean;
  savedAt: Date;
}

// Re-export ThinkingLevel (defined in settings.ts) for convenience
export type { ThinkingLevel };
/** Model identifier — Claude shorthands or concrete model IDs from any provider */
export type ModelType = string;
export interface TaskMetadata {
  // The description the user entered (shown on the task card)
  userDescription?: string;

  // Origin tracking
  sourceType?: 'ideation' | 'manual' | 'imported' | 'insights' | 'roadmap' | 'github';
  ideationType?: string;  // e.g., 'code_improvements', 'security_hardening'
  ideaId?: string;  // Reference to original idea if converted
  featureId?: string;  // Reference to roadmap feature if from roadmap
  githubIssueNumber?: number;  // Reference to GitHub issue number if from GitHub (single issue)
  githubIssueNumbers?: number[];  // Reference to multiple GitHub issues if from a batch
  githubUrl?: string;  // GitHub issue URL
  githubBatchTheme?: string;  // Theme/title of the GitHub issue batch

  // Context
  rationale?: string;  // Why this task matters
  problemSolved?: string;  // What problem this addresses
  targetAudience?: string;  // Who benefits

  // Technical details
  affectedFiles?: string[];  // Files likely to be modified
  dependencies?: string[];  // Other features/tasks this depends on
  acceptanceCriteria?: string[];  // What defines "done"

  // Type-specific metadata (from different idea types)
  performanceCategory?: string;
  uiuxCategory?: string;
  codeQualitySeverity?: 'suggestion' | 'minor' | 'major' | 'critical';

  // Image attachments (screenshots, mockups, diagrams)
  attachedImages?: ImageAttachment[];

  // MCP connectors enabled for this task (ids: context7, memory, electron, puppeteer, custom ids).
  // Copied from the Connectors defaults when the task is created; unset means use the defaults
  mcpConnectors?: string[];
  // The Puppeteer connector's browser profile for this task, set only when one was picked for it:
  // null is Puppeteer's own Chrome; unset follows Settings > Connectors
  puppeteerBrowser?: PuppeteerBrowserChoice | null;

  // Git/Worktree configuration
  baseBranch?: string;  // Override base branch for this task's worktree
  prUrl?: string;  // GitHub PR URL if task has been submitted as a PR
  prState?: PullRequestState;  // The PR's last known state (set when created or merged, read once from GitHub otherwise)
  useWorktree?: boolean;  // If false, use direct mode (no worktree isolation) - default is true for safety
  useLocalBranch?: boolean;  // If true, use the local branch directly instead of preferring origin/branch (preserves gitignored files)
  pushNewBranches?: boolean;  // If false, keep the task branch local-only instead of auto-pushing to origin

  // Archive status
  archivedAt?: string;  // ISO date when task was archived
  archivedInVersion?: string;  // Version in which task was archived (from changelog)
}

/**
 * A task paused because the provider's usage limit was hit
 * (e.g. "You've hit your session limit · resets 8:30pm (Asia/Yerevan)").
 * The task sits in the Queue column until `resetAt`, when the main process
 * resumes it from its saved plan/worktree state.
 */
export interface RateLimitHold {
  /** ISO 8601 time when the limit resets and the task should resume */
  resetAt: string;
  /** Original limit message from the provider */
  message: string;
  /** ISO 8601 time when the task was put on hold */
  pausedAt: string;
  /** Build phase that was interrupted (planning, coding, qa_review, qa_fixing) */
  phase?: string;
}

export interface Task {
  id: string;
  specId: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  reviewReason?: ReviewReason;  // Why task needs human review (only set when status is 'human_review')
  subtasks: Subtask[];
  qaReport?: QAReport;
  logs: string[];
  metadata?: TaskMetadata;  // Rich metadata from ideation or manual entry
  executionProgress?: ExecutionProgress;  // Real-time execution progress
  releasedInVersion?: string;  // Version in which this task was released
  stagedInMainProject?: boolean;  // True if changes were staged to main project (worktree merged with --no-commit)
  stagedAt?: string;  // ISO timestamp when changes were staged
  location?: 'main' | 'worktree';  // Where task was loaded from (main project or worktree)
  specsPath?: string;  // Full path to specs directory for this task
  rateLimitHold?: RateLimitHold;  // Set while the task is queued waiting for a rate-limit reset
  claudeRun?: ClaudeRunInfo;  // Claude Code run state (claude_run.json): triage, plan, session, phases, validation
  createdAt: Date;
  updatedAt: Date;
}

// Implementation Plan (from workbench)
export interface ImplementationPlan {
  feature?: string;  // Some plans use 'feature', some use 'title'
  title?: string;    // Alternative to 'feature' for task name
  workflow_type: string;
  services_involved?: string[];
  phases: Phase[];
  final_acceptance: string[];
  created_at: string;
  updated_at: string;
  spec_file: string;
  // Added for UI status persistence
  status?: TaskStatus;
  planStatus?: string;
  reviewReason?: ReviewReason;
  xstateState?: string;  // Persisted XState machine state for restoration (e.g., 'planning', 'coding')
  lastEvent?: {
    eventId: string;
    sequence: number;
    type: string;
    timestamp: string;
  };
  recoveryNote?: string;
  description?: string;
  rateLimitHold?: RateLimitHold | null;  // Persisted rate-limit hold (see RateLimitHold)
}

interface Phase {
  phase: number;
  name: string;
  type: string;
  subtasks: PlanSubtask[];
  depends_on?: number[];
}

export interface PlanSubtask {
  id: string;
  /** Short summary (3-10 words) — the primary display field */
  title: string;
  /** Detailed implementation notes for the coder agent */
  description: string;
  status: SubtaskStatus;
  verification?: {
    type: string;
    run?: string;
    scenario?: string;
  };
}

// Workspace management types (for human review)
export interface WorktreeStatus {
  exists: boolean;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  commitCount?: number;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

// Conflict severity levels from merge system
export type ConflictSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

// Type of conflict
type ConflictType = 'semantic' | 'git';

// Information about a detected conflict
export interface MergeConflict {
  file: string;
  location: string;
  tasks: string[];
  severity: ConflictSeverity;
  canAutoMerge: boolean;
  strategy?: string;
  reason: string;
  type?: ConflictType; // 'semantic' = parallel task conflict, 'git' = branch divergence
}

// Path-mapped file that needs AI merge due to rename
interface PathMappedAIMerge {
  oldPath: string;
  newPath: string;
  reason: string;
}

// Conflict scenario types for better UX messaging
// - 'already_merged': Task changes already identical in target branch
// - 'superseded': Target has newer version of same feature
// - 'diverged': Standard diverged branches (AI can resolve)
// - 'normal_conflict': Actual conflicting changes
type ConflictScenario = 'already_merged' | 'superseded' | 'diverged' | 'normal_conflict';

// Git-level conflict information (branch divergence)
export interface GitConflictInfo {
  hasConflicts: boolean;
  conflictingFiles: string[];
  needsRebase: boolean;
  commitsBehind: number;
  baseBranch: string;
  specBranch: string;
  // Files that need AI merge due to path mappings (file renames)
  pathMappedAIMerges?: PathMappedAIMerge[];
  // Total number of file renames detected
  totalRenames?: number;
  // Conflict scenario for better UX messaging
  scenario?: ConflictScenario;
  // Files that are already merged (identical in both branches)
  alreadyMergedFiles?: string[];
  // Human-readable message about the scenario
  scenarioMessage?: string;
}

// Summary statistics from merge preview/execution
export interface MergeStats {
  totalFiles: number;
  conflictFiles: number;
  totalConflicts: number;
  autoMergeable: number;
  aiResolved?: number;
  humanRequired?: number;
  hasGitConflicts?: boolean; // True if there are git-level conflicts requiring rebase
  // Count of files needing AI merge due to path mappings (file renames)
  pathMappedAIMergeCount?: number;
}

// Merge progress tracking (for progress bar during merge operations)
type MergeStage = 'analyzing' | 'detecting_conflicts' | 'resolving' | 'validating' | 'complete' | 'error';

export interface MergeProgress {
  stage: MergeStage;
  percent: number;
  message: string;
  details?: {
    conflicts_found?: number;
    conflicts_resolved?: number;
    current_file?: string;
  };
}

export interface WorktreeMergeResult {
  success: boolean;
  message: string;
  merged?: boolean;
  conflictFiles?: string[];
  staged?: boolean;
  alreadyStaged?: boolean;
  projectPath?: string;
  // AI-generated commit message suggestion (for stage-only mode)
  suggestedCommitMessage?: string;
  // New conflict info from smart merge
  conflicts?: MergeConflict[];
  stats?: MergeStats;
  gitConflicts?: GitConflictInfo; // Git-level conflict info
  // Preview mode results
  preview?: {
    files: string[];
    conflicts: MergeConflict[];
    summary: MergeStats;
    gitConflicts?: GitConflictInfo;
    // Uncommitted changes in the main project that could block merge
    uncommittedChanges?: {
      hasChanges: boolean;
      files: string[];
      count: number;
    } | null;
  };
}

export interface WorktreeDiscardResult {
  success: boolean;
  message: string;
}

/**
 * Options for creating a PR from a worktree
 */
export interface WorktreeCreatePROptions {
  targetBranch?: string;
  title?: string;
  draft?: boolean;
}

/** A pull request's state on GitHub */
export type PullRequestState = 'open' | 'merged' | 'closed';

/** Options for merging a task's pull request */
export interface WorktreeMergePROptions {
  /** Branch to merge into; the PR's current base when omitted */
  targetBranch?: string;
}

/** Steps of merging a task's pull request (progress events) */
export type MergePRStep = 'checking' | 'pulling' | 'resolving' | 'verifying' | 'pushing' | 'merging';

export interface MergePRProgress {
  step: MergePRStep;
  params?: Record<string, string | number>;
}

/** Result of merging a task's pull request */
export interface WorktreeMergePRResult {
  success: boolean;
  /** The PR was already merged */
  alreadyMerged?: boolean;
  targetBranch?: string;
  /** Files whose conflicts Claude Code resolved */
  conflictedFiles?: string[];
  /** Claude Code's account of the conflict resolution */
  summary?: string;
  error?: string;
}

/** Steps of merging a task's branch locally (progress events) */
export type LocalMergeStep = 'checking' | 'pulling' | 'checkingConflicts' | 'resolving' | 'verifying' | 'merging';

export interface LocalMergeProgress {
  step: LocalMergeStep;
  params?: Record<string, string | number>;
}

/** Why the base branch could not be brought up to date before a local merge (it merged as it was) */
export interface LocalMergePullNote {
  /** fetchFailed: the remote could not be reached; notFastForward: the local branch diverged from it */
  reason: 'fetchFailed' | 'notFastForward';
  /** The base branch's upstream (e.g. `origin/main`) */
  upstream: string;
  detail?: string;
}

/** Result of merging a task's branch into its base branch with git, locally */
export interface WorktreeLocalMergeResult {
  success: boolean;
  /** Branch the task branch was merged into */
  targetBranch?: string;
  /** The task branch */
  sourceBranch?: string;
  /** The base branch already had the task's commits, so nothing was merged */
  alreadyMerged?: boolean;
  /** Files whose conflicts Claude Code resolved in the task's worktree before the merge */
  resolvedConflicts?: string[];
  /** Files with conflicts that could not be resolved (the merge was undone) */
  conflictedFiles?: string[];
  /** Claude Code's account of the conflict resolution */
  summary?: string;
  /** Set when the base branch could not be pulled first */
  pullNote?: LocalMergePullNote;
  error?: string;
}

/**
 * Result of creating a PR from a worktree
 */
export interface WorktreeCreatePRResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  message?: string;  // Human-readable message for both success and error cases
  alreadyExists?: boolean;
}

/**
 * Information about a single spec worktree
 * Per-spec architecture: Each spec has its own worktree at .worktrees/{spec-name}/
 */
export interface WorktreeListItem {
  specName: string;
  path: string;
  branch: string;
  baseBranch: string;
  commitCount?: number;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  /** True if git commands failed on this worktree (corrupted/orphaned state) */
  isOrphaned?: boolean;
}

/**
 * Result of listing all spec worktrees
 */
export interface WorktreeListResult {
  worktrees: WorktreeListItem[];
}

export interface TaskRecoveryResult {
  taskId: string;
  recovered: boolean;
  newStatus: TaskStatus;
  message: string;
  autoRestarted?: boolean;
}

export interface TaskRecoveryOptions {
  targetStatus?: TaskStatus;
  autoRestart?: boolean;
}

export interface TaskStartOptions {
  parallel?: boolean;
  workers?: number;
  model?: string;
  baseBranch?: string; // Override base branch for worktree creation
}

/** Options of a "request changes" review */
export interface TaskReviewOptions {
  /**
   * Discard the task's worktree, branch and run history and redo it from scratch, instead of
   * applying the feedback to what the session already built. Off by default.
   */
  startOver?: boolean;
}
