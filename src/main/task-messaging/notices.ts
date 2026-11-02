/**
 * Workbench notices
 * =================
 *
 * Short `[Workbench]` messages the broker sends on its own, so parallel tasks know about each
 * other without asking. Driven by the task hooks (`state`, `files-edited`) and the project's task
 * changelog (which files each task changes):
 *
 * - a task started                      -> the other active tasks
 * - two tasks' changes conflict          -> both, naming the files and lines (once per pair and
 *                                          file while it lasts). Checked after a task edits a file
 *                                          another task changes, with a test merge of both tasks'
 *                                          work (`conflict-check.ts`); changes to different parts
 *                                          of a file merge cleanly and get no notice. When the
 *                                          test merge can't run, sharing a file is announced
 * - a task finished (Human Review)      -> active tasks that change the same files, with its
 *                                          summary and its "Decisions/API changes" line
 * - a task was merged                   -> every other unfinished task; the ones based on the branch
 *                                          it was merged into take it in (`merge-sync.ts`, also
 *                                          while notices are off)
 *
 * Notices are batched per target for a few seconds and deduplicated.
 */
import { readFile } from 'fs/promises';
import path from 'path';
import type { Project, Task, TaskStatus } from '../../shared/types';
import { getTaskWorktreeBranch } from '../../shared/utils/claude-run';
import { taskSessionName } from '../../shared/utils/task-messaging';
import { taskHooks, type TaskHookEvents } from '../task-hooks';
import { foldTaskChangelog, getTaskChangelogPath, readTaskChangelog, type TaskChangelogTask } from '../task-changelog';
import { deliverToTask, getTaskMessagingEnv, taskSpecDir } from './broker';
import { findConflicts, type FindConflicts, type TaskConflict } from './conflict-check';
import { MergeSync, hasTaskMerge, recordTaskMerge, takeTaskMerge, type MergeSyncOptions, type TaskMergeInfo } from './merge-sync';
import { isStoppedByUser } from '../task-resync/user-stop';

/** Tasks that get notices: running, reviewed by AI, or waiting in the queue (their inbox) */
const RECIPIENT_STATUSES = new Set<TaskStatus>(['queue', 'in_progress', 'ai_review']);
/** Tasks whose changes are not merged yet */
const UNMERGED_STATUSES = new Set<TaskStatus>(['queue', 'in_progress', 'ai_review', 'human_review', 'pr_created', 'error']);
const MAX_FILES_LISTED = 10;
const MAX_SUMMARY = 300;
/**
 * The line a finished task's summary ends with when it made decisions or changed APIs (the
 * validate step asks for it): "Decisions/API changes: ..."
 */
const DECISIONS_LINE = /^[\s>*_-]*decisions(?:\s*(?:\/|and|&)\s*api changes)?[*_]*\s*:[*_]*\s*(.+)$/im;
/** What a session writes when there is nothing to say */
const NOTHING = /^(?:none|n\/a|no|-+|nothing(?: notable)?)\.?$/i;

function clip(text: string, max: number): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A finished task's summary for its notice, and its "Decisions/API changes" line taken out of it
 * (undefined when the summary has none, or says there are none)
 */
function splitSummary(text: string): { summary?: string; decisions?: string } {
  const match = DECISIONS_LINE.exec(text);
  if (!match) return { summary: clip(text, MAX_SUMMARY) };
  const decisions = match[1].replace(/[*_]+$/, '').trim();
  return {
    summary: clip(text.replace(match[0], ''), MAX_SUMMARY),
    decisions: NOTHING.test(decisions) ? undefined : clip(decisions, MAX_SUMMARY),
  };
}

export interface TaskNoticesOptions {
  /** How long notices for one target are collected before they are sent */
  batchMs?: number;
  /** How long a task's edits are collected before overlaps are checked */
  editBatchMs?: number;
  /** Test merge of two tasks' work (`conflict-check.ts`; tests pass their own) */
  findConflicts?: FindConflicts;
  /** Whether a task that entered Done was merged into its base branch */
  isMerged?: (project: Project, task: Task, branch: string | undefined, base: string) => Promise<boolean>;
  /** Whether notices are on now (Settings > Agents) */
  isEnabled?: () => boolean;
  /** Whether a task's run is active (the AgentManager in the app) */
  isRunning?: MergeSyncOptions['isRunning'];
  /** The repository's default branch, for tasks and projects that name none */
  defaultBranch?: MergeSyncOptions['defaultBranch'];
  /** A task that is not running has to take in a merge: bring it back to In Progress (task-resync) */
  requestResync?: MergeSyncOptions['requestResync'];
}

function describe(projectId: string, task: Pick<Task, 'specId' | 'title'>): string {
  const title = task.title ? ` "${task.title.replace(/"/g, "'")}"` : '';
  return `Task ${task.specId}${title} (session ${taskSessionName(projectId, task.specId)})`;
}

function listFiles(files: string[]): string {
  const shown = files.slice(0, MAX_FILES_LISTED);
  const more = files.length > shown.length ? ` and ${files.length - shown.length} more` : '';
  return `${shown.map((file) => `\`${file}\``).join(', ')}${more}`;
}

/** Conflicted files with the lines on one side: "`a.ts` (lines 4-6), `b.ts`" */
function listConflicts(conflicts: TaskConflict[], side: 'lines' | 'otherLines'): string {
  const shown = conflicts.slice(0, MAX_FILES_LISTED);
  const more = conflicts.length > shown.length ? ` and ${conflicts.length - shown.length} more` : '';
  return `${shown.map((c) => `\`${c.file}\`${c[side] ? ` (${c[side]})` : ''}`).join(', ')}${more}`;
}

const key = (projectId: string, specId: string) => `${projectId}\u0000${specId}`;

/** A pair of tasks whose work is test-merged: `editor` just edited files `other` changes too */
interface PairCheck {
  project: Project;
  editorId: string;
  otherId: string;
  shared: Set<string>;
}

/** Batched, deduplicated notices for the tasks of all projects */
export class TaskNotices {
  private readonly batchMs: number;
  private readonly editBatchMs: number;
  private readonly lastStatus = new Map<string, TaskStatus>();
  /** Files each task edited while the app ran (the changelog may not have them yet) */
  private readonly edited = new Map<string, Set<string>>();
  private readonly pendingEdits = new Map<string, { project: Project; files: Map<string, Set<string>>; timer: ReturnType<typeof setTimeout> }>();
  /** `<project>\0<a>\0<b>\0<file>` (a < b): file overlaps announced when a test merge couldn't run */
  private readonly announcedOverlaps = new Set<string>();
  /** `<project>\0<a>\0<b>` (a < b) -> files announced as conflicting, while they still conflict */
  private readonly announcedConflicts = new Map<string, Set<string>>();
  /** Per project: pairs waiting for a test merge (one entry per pair), run one at a time */
  private readonly pairChecks = new Map<string, { pending: Map<string, PairCheck>; running: Promise<void> | null }>();
  private readonly batches = new Map<string, { projectId: string; specId: string; lines: string[]; timer: ReturnType<typeof setTimeout> }>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly mergeSync: MergeSync;

  constructor(private readonly options: TaskNoticesOptions = {}) {
    this.batchMs = options.batchMs ?? 3000;
    this.editBatchMs = options.editBatchMs ?? 1000;
    this.mergeSync = new MergeSync({
      // Tasks take in a merge whether or not notices are on; only the notices follow the switch
      queueNotice: (projectId, specId, text) => {
        if (this.enabled()) this.queueNotice(projectId, specId, text);
      },
      isRunning: options.isRunning,
      defaultBranch: options.defaultBranch,
      requestResync: options.requestResync,
    });
  }

  /** Listen to the task hooks */
  start(): this {
    this.unsubscribe.push(
      taskHooks.on('state', (event) => this.onState(event)),
      taskHooks.on('files-edited', (event) => this.onFilesEdited(event)),
    );
    return this;
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    for (const pending of this.pendingEdits.values()) clearTimeout(pending.timer);
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.pendingEdits.clear();
    this.batches.clear();
    for (const queue of this.pairChecks.values()) queue.pending.clear();
  }

  /** Send every collected notice now and wait for it (tests, shutdown) */
  async flush(): Promise<void> {
    await Promise.all([...this.pendingEdits.keys()].map((projectId) => this.checkOverlaps(projectId)));
    await Promise.all([...this.pairChecks.values()].map((queue) => queue.running));
    await this.mergeSync.flush();
    await Promise.all([...this.batches.keys()].map((target) => this.sendBatch(target)));
  }

  private enabled(): boolean {
    return this.options.isEnabled?.() ?? true;
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  async onState({ project, task, status, state }: TaskHookEvents['state']): Promise<void> {
    const taskKey = key(project.id, task.specId);
    const previous = this.lastStatus.get(taskKey);
    this.lastStatus.set(taskKey, status);
    if (previous === status) return;
    // The first state machine status seen for a task since the app started is the state its
    // machine was restored in (created on demand), not a transition. Statuses set without the
    // machine (no `state`) still count; In Progress has its own check below
    if (previous === undefined && state !== undefined && status !== 'in_progress') return;

    if (status === 'in_progress') {
      const fresh = previous === 'backlog' || previous === 'queue' || (previous === undefined && (!state || state === 'planning'));
      if (!fresh || !this.enabled()) return;
      for (const other of this.recipients(project.id, task.specId)) {
        this.queueNotice(project.id, other.specId, `${describe(project.id, task)} started.`);
      }
      return;
    }

    // A run that ended in an error waits in Human Review too, but it didn't finish anything
    if (status === 'human_review' && state !== 'error' && previous !== 'pr_created') {
      if (!this.enabled()) return;
      const run = await this.runOf(project, task.specId);
      // A stopped run waits for the user too, but it didn't finish anything
      if (run.stopped) return;
      const files = await this.filesOf(project, task.specId);
      const { summary, decisions } = run;
      await this.notifyOverlapping(project, task, files, (shared) =>
        `${describe(project.id, task)} finished and waits for review (not merged yet). It changes files you also change: ${listFiles(shared)}.` +
        `${summary ? ` Its summary: ${summary}` : ''}${decisions ? `\nDecisions and API changes: ${decisions}` : ''}`);
      return;
    }

    if (status === 'done') {
      const files = await this.filesOf(project, task.specId);
      const merge = await this.mergeOf(project, task, files);
      this.edited.delete(key(project.id, task.specId));
      if (!merge) return;
      await this.mergeSync.onMerged({ project, merged: task, who: describe(project.id, task), info: merge, files });
    }
  }

  onFilesEdited({ project, task, files }: TaskHookEvents['files-edited']): void {
    if (files.length === 0) return;
    const own = this.edited.get(key(project.id, task.specId)) ?? new Set<string>();
    for (const file of files) own.add(file);
    this.edited.set(key(project.id, task.specId), own);
    if (!this.enabled()) return;
    let pending = this.pendingEdits.get(project.id);
    if (!pending) {
      pending = { project, files: new Map(), timer: setTimeout(() => void this.checkOverlaps(project.id), this.editBatchMs) };
      this.pendingEdits.set(project.id, pending);
    }
    const set = pending.files.get(task.specId) ?? new Set<string>();
    for (const file of files) set.add(file);
    pending.files.set(task.specId, set);
  }

  /**
   * A task is about to enter Done by hand, which deletes its branch: record now whether it was
   * merged (outside Workbench), so its arrival in Done is still announced
   */
  async noteMergeBeforeDone(project: Project, task: Task): Promise<void> {
    if (hasTaskMerge(project.id, task.specId)) return;
    const merge = await this.mergeOf(project, task, await this.filesOf(project, task.specId));
    if (merge) recordTaskMerge(project.id, task.specId, merge);
  }

  // ---------------------------------------------------------------------------
  // Overlaps
  // ---------------------------------------------------------------------------

  /** The edits collected for a project: queue a test merge for each pair of tasks that share a file */
  private async checkOverlaps(projectId: string): Promise<void> {
    const pending = this.pendingEdits.get(projectId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingEdits.delete(projectId);
    const env = getTaskMessagingEnv();
    if (!env) return;
    const { project } = pending;
    const tasks = env.getTasks(projectId).filter((t) => !t.metadata?.archivedAt);
    const fold = await this.fold(project);

    for (const [editorId, editedFiles] of pending.files) {
      if (!tasks.some((t) => t.specId === editorId)) continue;
      for (const other of tasks) {
        if (other.specId === editorId || !UNMERGED_STATUSES.has(other.status)) continue;
        const theirs = this.filesFrom(fold.get(other.specId), projectId, other.specId);
        const shared = [...editedFiles].filter((file) => theirs.has(file));
        if (shared.length > 0) this.queuePairCheck({ project, editorId, otherId: other.specId, shared: new Set(shared) });
      }
    }
  }

  /** One check per pair waits at a time (a newer edit joins it); a project's checks run one by one */
  private queuePairCheck(check: PairCheck): void {
    const projectId = check.project.id;
    let queue = this.pairChecks.get(projectId);
    if (!queue) {
      queue = { pending: new Map(), running: null };
      this.pairChecks.set(projectId, queue);
    }
    const pair = [check.editorId, check.otherId].sort().join('\u0000');
    const waiting = queue.pending.get(pair);
    if (waiting) for (const file of waiting.shared) check.shared.add(file);
    queue.pending.set(pair, check);
    if (!queue.running) {
      const current = queue;
      current.running = (async () => {
        try {
          for (let next = current.pending.entries().next(); !next.done; next = current.pending.entries().next()) {
            const [waitingPair, waitingCheck] = next.value;
            current.pending.delete(waitingPair);
            await this.checkPair(waitingCheck);
          }
        } finally {
          current.running = null;
        }
      })();
    }
  }

  /** Test-merge a pair's work and tell both tasks about new conflicts */
  private async checkPair({ project, editorId, otherId, shared }: PairCheck): Promise<void> {
    const projectId = project.id;
    let conflicts: TaskConflict[] | null;
    try {
      conflicts = await (this.options.findConflicts ?? findConflicts)(project, editorId, otherId);
    } catch {
      conflicts = null;
    }
    const tasks = getTaskMessagingEnv()?.getTasks(projectId) ?? [];
    const editor = tasks.find((t) => t.specId === editorId && !t.metadata?.archivedAt);
    const other = tasks.find((t) => t.specId === otherId && !t.metadata?.archivedAt);
    if (!editor || !other || !UNMERGED_STATUSES.has(other.status) || !this.enabled()) return;
    const pair = `${projectId}\u0000${[editorId, otherId].sort().join('\u0000')}`;

    if (conflicts === null) {
      // No test merge: tell them they share files, once per pair and file
      const fresh = [...shared].filter((file) => !this.announcedOverlaps.has(`${pair}\u0000${file}`)).sort();
      if (fresh.length === 0) return;
      for (const file of fresh) this.announcedOverlaps.add(`${pair}\u0000${file}`);
      const advice = 'Changes to different parts of a file merge cleanly; if you both need to change the same lines, agree on who changes what via message_task.';
      if (RECIPIENT_STATUSES.has(editor.status)) {
        this.queueNotice(projectId, editorId, `${describe(projectId, other)} also changes ${listFiles(fresh)}, which you are editing. ${advice}`);
      }
      if (RECIPIENT_STATUSES.has(other.status)) {
        this.queueNotice(projectId, otherId, `${describe(projectId, editor)} is editing ${listFiles(fresh)}, which you also change. ${advice}`);
      }
      return;
    }

    // Files that no longer conflict are forgotten, so a new conflict in them is announced again
    const announced = this.announcedConflicts.get(pair) ?? new Set<string>();
    const fresh = conflicts.filter((c) => !announced.has(c.file));
    if (conflicts.length > 0) this.announcedConflicts.set(pair, new Set(conflicts.map((c) => c.file)));
    else this.announcedConflicts.delete(pair);
    if (fresh.length === 0) return;
    const advice = 'you both change the same lines. Agree with it via message_task on who changes what.';
    if (RECIPIENT_STATUSES.has(editor.status)) {
      this.queueNotice(projectId, editorId, `Your changes conflict with ${describe(projectId, other)} in ${listConflicts(fresh, 'lines')}: ${advice}`);
    }
    if (RECIPIENT_STATUSES.has(other.status)) {
      this.queueNotice(projectId, otherId, `Your changes conflict with ${describe(projectId, editor)} in ${listConflicts(fresh, 'otherLines')}: ${advice}`);
    }
  }

  /**
   * Where a task that entered Done was merged, and how: as Workbench recorded it, else a merged
   * pull request, else its branch found in its base branch (merged locally, when it changed
   * `files`); undefined: not merged
   */
  private async mergeOf(project: Project, task: Task, files: string[]): Promise<TaskMergeInfo | undefined> {
    const recorded = takeTaskMerge(project.id, task.specId);
    if (recorded) return recorded;
    const env = getTaskMessagingEnv();
    const current = env?.getTasks(project.id).find((t) => t.specId === task.specId) ?? task;
    const base = await this.mergeSync.baseOf(project, current);
    if (current.metadata?.prState === 'merged' || task.metadata?.prState === 'merged') return { into: base, via: 'pr' };
    // A branch with no changes of its own is in its base branch without having been merged
    if (files.length === 0) return undefined;
    const fold = await this.fold(project);
    return (await this.isMerged(project, current, fold.get(task.specId)?.branch, base)) ? { into: base, via: 'local' } : undefined;
  }

  /** Notify the active tasks whose files overlap `files` */
  private async notifyOverlapping(project: Project, task: Task, files: string[], text: (shared: string[]) => string): Promise<void> {
    if (files.length === 0) return;
    const fold = await this.fold(project);
    const mine = new Set(files);
    for (const other of this.recipients(project.id, task.specId)) {
      const shared = [...this.filesFrom(fold.get(other.specId), project.id, other.specId)].filter((file) => mine.has(file)).sort();
      if (shared.length > 0) this.queueNotice(project.id, other.specId, text(shared));
    }
  }

  // ---------------------------------------------------------------------------
  // Batches
  // ---------------------------------------------------------------------------

  private queueNotice(projectId: string, specId: string, line: string): void {
    const target = key(projectId, specId);
    let batch = this.batches.get(target);
    if (!batch) {
      batch = { projectId, specId, lines: [], timer: setTimeout(() => void this.sendBatch(target), this.batchMs) };
      this.batches.set(target, batch);
    }
    if (!batch.lines.includes(line)) batch.lines.push(line);
  }

  private async sendBatch(target: string): Promise<void> {
    const batch = this.batches.get(target);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batches.delete(target);
    const env = getTaskMessagingEnv();
    const task = env?.getTasks(batch.projectId).find((t) => t.specId === batch.specId);
    if (!task || batch.lines.length === 0) return;
    const text = batch.lines.length === 1
      ? batch.lines[0]
      : `Updates on parallel tasks:\n${batch.lines.map((line) => `- ${line}`).join('\n')}`;
    await deliverToTask(batch.projectId, task, { kind: 'workbench' }, text);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Other tasks of the project that get notices now */
  private recipients(projectId: string, specId: string): Task[] {
    const env = getTaskMessagingEnv();
    return (env?.getTasks(projectId) ?? []).filter(
      (t) => t.specId !== specId && RECIPIENT_STATUSES.has(t.status) && !t.metadata?.archivedAt
    );
  }

  private async fold(project: Project): Promise<Map<string, TaskChangelogTask>> {
    if (!project.autoBuildPath) return new Map();
    return foldTaskChangelog(await readTaskChangelog(getTaskChangelogPath(project.path, project.autoBuildPath)));
  }

  private filesFrom(entry: TaskChangelogTask | undefined, projectId: string, specId: string): Set<string> {
    return new Set([...(entry?.files ?? []), ...(this.edited.get(key(projectId, specId)) ?? [])]);
  }

  private async filesOf(project: Project, specId: string): Promise<string[]> {
    const fold = await this.fold(project);
    return [...this.filesFrom(fold.get(specId), project.id, specId)].sort();
  }

  /**
   * The task's summary, its "Decisions/API changes" line and whether its run was stopped, from its
   * `claude_run.json`
   */
  private async runOf(project: Project, specId: string): Promise<{ summary?: string; decisions?: string; stopped: boolean }> {
    try {
      const info = JSON.parse(await readFile(path.join(taskSpecDir(project, specId), 'claude_run.json'), 'utf-8')) as {
        summary?: string;
        validation?: { summary?: string };
        phases?: Array<{ isError?: boolean; error?: string }>;
      };
      const last = info.phases?.at(-1);
      // The user's stop is recorded before the task enters Human Review; the run writes its
      // "Stopped" phase later (and not at all when stopped before a step began)
      const stopped = isStoppedByUser(taskSpecDir(project, specId)) || (last?.isError === true && last.error === 'Stopped');
      const text = info.validation?.summary?.trim() || info.summary?.trim() || '';
      return { ...splitSummary(text), stopped };
    } catch {
      return { stopped: isStoppedByUser(taskSpecDir(project, specId)) };
    }
  }

  private async isMerged(project: Project, task: Task, branch: string | undefined, base: string): Promise<boolean> {
    if (!this.options.isMerged) return false;
    try {
      // The changelog names a detached worktree's branch `HEAD`
      return await this.options.isMerged(project, task, branch && branch !== 'HEAD' ? branch : getTaskWorktreeBranch(task.specId), base);
    } catch {
      return false;
    }
  }
}
