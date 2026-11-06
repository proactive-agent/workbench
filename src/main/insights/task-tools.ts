/**
 * Task tools of the Claude chat
 * =============================
 *
 * What the user can do with the project's tasks in the UI, as tools for the Claude chat
 * (served over MCP by `task-tools-server.ts`): list and inspect tasks, create and edit them,
 * start, stop, retry and move them between the board's columns, request changes, create and
 * merge their pull requests, archive and delete them, and message them (through Workbench's
 * task messaging broker, so a task that is not running gets the message when it next runs).
 *
 * Every tool goes through the same IPC handler as the UI (see `ipc-registry.ts`) and the
 * board's move rules, so the chat can't do anything the board wouldn't allow.
 *
 * A task id is only unique inside its project, so every one of those calls ends with the chat's
 * own project (`context.projectId`), exactly as the board sends the project of the card the user
 * acted on. Without it the handlers would have to search the projects for the id and could answer
 * with another project's task of the same id, and the run lookups refuse an id two projects run
 * rather than guess, which would turn a stop or a retry into a reported failure.
 */

import { IPC_CHANNELS } from '../../shared/constants';
import { canMoveTask, getAllowedTaskMoves, getTaskColumn, resolveMaxParallelTasks } from '../../shared/constants/task';
import { customMcpServerIds, getDefaultMcpConnectorIds, normalizeMcpConnectorIds } from '../../shared/utils/mcp-connectors';
import type {
  IPCResult,
  Project,
  Task,
  TaskLogs,
  TaskMetadata,
  TaskStatus,
  WorktreeCreatePRResult,
  WorktreeMergePRResult,
  WorktreeStatus,
} from '../../shared/types';
import type { AppSettings } from '../../shared/types/settings';
import { invokeIpcHandler } from '../ipc-handlers/ipc-registry';
import { projectStore } from '../project-store';
import { readSettingsFile } from '../settings-utils';
import { resolveClaudeCodeTaskSettings } from '../claude-code/settings';
import { MAX_MESSAGE_LENGTH, deliverToTask } from '../task-messaging/broker';

export interface TaskToolContext {
  projectId: string;
  /** Called after a tool changed tasks, so the board reloads them */
  onTasksChanged: () => void;
}

export interface TaskTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Changes tasks (the board reloads after it) */
  mutates: boolean;
  run: (context: TaskToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

/** Board columns a task can be moved to */
const MOVE_TARGETS = ['backlog', 'queue', 'in_progress', 'human_review', 'done'] as const;
const COLUMN_NAMES: Record<string, string> = {
  backlog: 'Planning',
  queue: 'Queue',
  in_progress: 'In Progress',
  ai_review: 'AI Review',
  human_review: 'Human Review',
  done: 'Done',
};

const TASK_ID = { type: 'string', description: 'Task id (from list_tasks), e.g. "003-add-login"' };
const MAX_LOG_CONTENT = 600;

// =============================================================================
// Helpers
// =============================================================================

function project(context: TaskToolContext): Project {
  const found = projectStore.getProject(context.projectId);
  if (!found) throw new Error('The project is not open in Workbench');
  return found;
}

function findTask(context: TaskToolContext, taskId: unknown): Task {
  if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('taskId is required');
  projectStore.invalidateTasksCache(context.projectId);
  const task = projectStore.getTasks(context.projectId).find((t) => t.id === taskId || t.specId === taskId);
  if (!task) throw new Error(`No task "${taskId}" in this project (list_tasks shows the ids)`);
  return task;
}

/** Call a task IPC handler; its error becomes the tool's error */
async function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await invokeIpcHandler<IPCResult<T>>(channel, ...args);
  if (!result?.success) throw new Error(result?.error || 'The action failed');
  return result.data as T;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function columnName(status: TaskStatus): string {
  return COLUMN_NAMES[getTaskColumn(status)] ?? status;
}

function summarize(task: Task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    column: columnName(task.status),
    ...(task.reviewReason ? { reviewReason: task.reviewReason } : {}),
    ...(task.metadata?.prUrl ? { prUrl: task.metadata.prUrl, prState: task.metadata.prState } : {}),
    ...(task.metadata?.archivedAt ? { archived: true } : {}),
    baseBranch: task.metadata?.baseBranch,
    updatedAt: task.updatedAt,
  };
}

/** Start a task, or queue it when the project already runs as many tasks as it may */
async function startOrQueue(context: TaskToolContext, task: Task): Promise<'started' | 'queued'> {
  const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
  const maxParallel = resolveMaxParallelTasks(settings.maxParallelTasks, project(context).settings?.maxParallelTasks);
  const running = projectStore.getTasks(context.projectId).filter(
    (t) => t.id !== task.id && t.status === 'in_progress' && !t.metadata?.archivedAt
  ).length;
  if (running >= maxParallel) {
    await ipc(IPC_CHANNELS.TASK_UPDATE_STATUS, task.id, 'queue', undefined, context.projectId);
    return 'queued';
  }
  await invokeIpcHandler(IPC_CHANNELS.TASK_START, task.id, undefined, context.projectId);
  return 'started';
}

function assertMove(task: Task, to: TaskStatus): void {
  if (canMoveTask(task.status, to)) return;
  const allowed = getAllowedTaskMoves(task.status).map((column) => COLUMN_NAMES[column]).join(', ') || 'none';
  throw new Error(`A task in ${columnName(task.status)} can't be moved to ${COLUMN_NAMES[to] ?? to} (allowed: ${allowed})`);
}

// =============================================================================
// Tools
// =============================================================================

export const TASK_TOOLS: TaskTool[] = [
  {
    name: 'list_tasks',
    description: "List the project's tasks with their status and board column. Archived tasks are left out unless asked for.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'array', items: { type: 'string' }, description: 'Only these statuses (backlog, queue, in_progress, ai_review, human_review, pr_created, error, done)' },
        includeArchived: { type: 'boolean' },
      },
    },
    mutates: false,
    run: async (context, args) => {
      projectStore.invalidateTasksCache(context.projectId);
      const statuses = Array.isArray(args.status) ? (args.status as string[]) : undefined;
      return projectStore.getTasks(context.projectId)
        .filter((task) => args.includeArchived === true || !task.metadata?.archivedAt)
        .filter((task) => !statuses || statuses.includes(task.status))
        .map(summarize);
    },
  },
  {
    name: 'get_task',
    description: "A task's details: description, settings, Claude Code's task list, plan, steps and their cost, validation report, worktree changes, and the board columns it can be moved to.",
    inputSchema: { type: 'object', properties: { taskId: TASK_ID }, required: ['taskId'] },
    mutates: false,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      const run = task.claudeRun;
      let worktree: WorktreeStatus | undefined;
      try {
        worktree = await ipc<WorktreeStatus>(IPC_CHANNELS.TASK_WORKTREE_STATUS, task.id, context.projectId);
      } catch {
        worktree = undefined;
      }
      return {
        ...summarize(task),
        description: task.description,
        allowedMoves: getAllowedTaskMoves(task.status).map((column) => column),
        useWorktree: task.metadata?.useWorktree !== false,
        connectors: task.metadata?.mcpConnectors,
        subtasks: task.subtasks.map((subtask) => ({ title: subtask.title || subtask.description, status: subtask.status })),
        ...(run ? {
          run: {
            triage: run.triage && { model: run.triage.model, effort: run.triage.effort, needsPlan: run.triage.needsPlan, scope: run.triage.scope },
            plan: run.plan,
            steps: run.phases.map((phase) => ({ name: phase.name, model: phase.model, costUsd: phase.costUsd, error: phase.error })),
            totalCostUsd: run.totalCostUsd,
            validation: run.validation,
            summary: run.summary,
          },
        } : {}),
        ...(worktree?.exists ? {
          worktree: {
            branch: worktree.branch,
            baseBranch: worktree.baseBranch,
            commits: worktree.commitCount,
            filesChanged: worktree.filesChanged,
            additions: worktree.additions,
            deletions: worktree.deletions,
          },
        } : {}),
      };
    },
  },
  {
    name: 'get_task_logs',
    description: "The latest entries of a task's logs (Claude Code's text and tool calls, by step).",
    inputSchema: {
      type: 'object',
      properties: { taskId: TASK_ID, limit: { type: 'number', description: 'How many of the latest entries (default 40, at most 200)' } },
      required: ['taskId'],
    },
    mutates: false,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      const logs = await ipc<TaskLogs | null>(IPC_CHANNELS.TASK_LOGS_GET, context.projectId, task.specId);
      if (!logs) return [];
      const limit = Math.min(Math.max(Number(args.limit) || 40, 1), 200);
      return [logs.phases.planning, logs.phases.coding, logs.phases.validation]
        .flatMap((phase) => phase?.entries ?? [])
        .slice(-limit)
        .map((entry) => ({
          at: entry.timestamp,
          step: entry.phase,
          type: entry.type,
          ...(entry.tool_name ? { tool: entry.tool_name, input: entry.tool_input } : {}),
          content: entry.content.length > MAX_LOG_CONTENT ? `${entry.content.slice(0, MAX_LOG_CONTENT)}...` : entry.content,
        }));
    },
  },
  {
    name: 'create_task',
    description: "Create a task in Planning: Claude Code will do it in its own git worktree once it's started. Write the description as the full instructions for that session. Set start to run it right away (it waits in Queue when the parallel task limit is reached).",
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What to do, with the context and acceptance criteria Claude Code needs' },
        title: { type: 'string', description: 'Short title (generated from the description when empty)' },
        baseBranch: { type: 'string', description: "Branch the task's worktree starts from (default: the project's main branch)" },
        useWorktree: { type: 'boolean', description: 'false works directly in the project checkout (default true)' },
        connectors: { type: 'array', items: { type: 'string' }, description: 'MCP connector ids for the task (default: the Connectors defaults)' },
        start: { type: 'boolean', description: 'Start the task right away' },
      },
      required: ['description'],
    },
    mutates: true,
    run: async (context, args) => {
      const description = text(args.description);
      if (!description) throw new Error('description is required');
      const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
      const metadata: TaskMetadata = {
        sourceType: 'manual',
        mcpConnectors: Array.isArray(args.connectors) ? normalizeMcpConnectorIds(args.connectors as string[], customMcpServerIds(settings.mcpConnectors)) : getDefaultMcpConnectorIds(settings.mcpConnectors),
      };
      const baseBranch = text(args.baseBranch) ?? project(context).settings?.mainBranch;
      if (baseBranch) metadata.baseBranch = baseBranch;
      if (args.useWorktree === false) metadata.useWorktree = false;
      const created = await ipc<Task>(IPC_CHANNELS.TASK_CREATE, context.projectId, text(args.title) ?? '', description, metadata);
      const started = args.start === true ? await startOrQueue(context, findTask(context, created.id)) : undefined;
      return { ...summarize(findTask(context, created.id)), ...(started ? { action: started } : {}) };
    },
  },
  {
    name: 'update_task',
    description: "Edit a task's title, description or settings (not while it runs).",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        title: { type: 'string' },
        description: { type: 'string' },
        baseBranch: { type: 'string' },
        useWorktree: { type: 'boolean' },
        connectors: { type: 'array', items: { type: 'string' } },
      },
      required: ['taskId'],
    },
    mutates: true,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      if (task.status === 'in_progress' || task.status === 'ai_review') throw new Error('Stop the task before editing it');
      const metadata: Partial<TaskMetadata> = {};
      if (text(args.baseBranch)) metadata.baseBranch = text(args.baseBranch);
      if (typeof args.useWorktree === 'boolean') metadata.useWorktree = args.useWorktree;
      if (Array.isArray(args.connectors)) {
        const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
        metadata.mcpConnectors = normalizeMcpConnectorIds(args.connectors as string[], customMcpServerIds(settings.mcpConnectors));
      }
      const updated = await ipc<Task>(IPC_CHANNELS.TASK_UPDATE, task.id, {
        ...(text(args.title) ? { title: text(args.title) } : {}),
        ...(text(args.description) ? { description: text(args.description) } : {}),
        ...(Object.keys(metadata).length ? { metadata } : {}),
      }, context.projectId);
      return summarize(updated ?? findTask(context, task.id));
    },
  },
  {
    name: 'start_task',
    description: 'Start a task (from Planning or Queue), or resume one in Human Review. It waits in Queue when the parallel task limit is reached.',
    inputSchema: { type: 'object', properties: { taskId: TASK_ID }, required: ['taskId'] },
    mutates: true,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      assertMove(task, 'in_progress');
      return { id: task.id, action: await startOrQueue(context, task) };
    },
  },
  {
    name: 'stop_task',
    description: 'Stop a running task. It goes back to Planning when nothing was implemented yet, otherwise to Human Review.',
    inputSchema: { type: 'object', properties: { taskId: TASK_ID }, required: ['taskId'] },
    mutates: true,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      if (task.status !== 'in_progress' && task.status !== 'ai_review') throw new Error('The task is not running');
      await invokeIpcHandler(IPC_CHANNELS.TASK_STOP, task.id, context.projectId);
      return summarize(findTask(context, task.id));
    },
  },
  {
    name: 'move_task',
    description: "Move a task to another board column, with the board's rules (get_task lists the allowed moves). Moving to In Progress starts it. Moving a task that still has a worktree to Done needs worktree: \"keep\" or \"delete\"; ask the user which one.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        to: { type: 'string', enum: [...MOVE_TARGETS] },
        worktree: { type: 'string', enum: ['keep', 'delete'], description: 'Done only: keep the task\'s worktree or delete it with its branch' },
      },
      required: ['taskId', 'to'],
    },
    mutates: true,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      const to = args.to as TaskStatus;
      if (!(MOVE_TARGETS as readonly string[]).includes(to)) throw new Error(`Unknown column "${String(args.to)}"`);
      assertMove(task, to);
      if (to === 'in_progress') return { id: task.id, action: await startOrQueue(context, task) };
      const options = to === 'done' && args.worktree
        ? (args.worktree === 'delete' ? { forceCleanup: true } : { keepWorktree: true })
        : undefined;
      const result = await invokeIpcHandler<IPCResult & { worktreeExists?: boolean }>(IPC_CHANNELS.TASK_UPDATE_STATUS, task.id, to, options, context.projectId);
      if (!result.success) {
        if (result.worktreeExists) {
          throw new Error('The task still has a worktree. Ask the user whether to keep it or delete it, then move it again with worktree "keep" or "delete".');
        }
        throw new Error(result.error || 'The task could not be moved');
      }
      return summarize(findTask(context, task.id));
    },
  },
  {
    name: 'retry_task',
    description: "Start a failed or stopped task over from a clean slate: discards its worktree changes and previous run, then starts it (or queues it).",
    inputSchema: { type: 'object', properties: { taskId: TASK_ID }, required: ['taskId'] },
    mutates: true,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      const result = await ipc<{ action: 'started' | 'queued' }>(IPC_CHANNELS.TASK_RETRY, task.id, context.projectId);
      return { id: task.id, action: result.action };
    },
  },
  {
    name: 'request_changes',
    description: 'Ask for changes on a task in Human Review: Claude Code continues its session with this feedback, then validates again.',
    inputSchema: {
      type: 'object',
      properties: { taskId: TASK_ID, feedback: { type: 'string', description: 'What to change' } },
      required: ['taskId', 'feedback'],
    },
    mutates: true,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      const feedback = text(args.feedback);
      if (!feedback) throw new Error('feedback is required');
      await ipc(IPC_CHANNELS.TASK_REVIEW, task.id, false, feedback, undefined, undefined, context.projectId);
      return { id: task.id, action: 'revising' };
    },
  },
  {
    name: 'create_pull_request',
    description: "Push a reviewed task's branch and open a GitHub pull request (title and description are written from its changes). The task waits in Human Review until the PR is merged.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        targetBranch: { type: 'string', description: "Branch to merge into (default: the task's base branch)" },
        title: { type: 'string' },
        draft: { type: 'boolean' },
      },
      required: ['taskId'],
    },
    mutates: true,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      const result = await ipc<WorktreeCreatePRResult>(IPC_CHANNELS.TASK_WORKTREE_CREATE_PR, task.id, {
        targetBranch: text(args.targetBranch),
        title: text(args.title),
        draft: args.draft === true,
      }, context.projectId);
      return { id: task.id, prUrl: result.prUrl, alreadyExists: result.alreadyExists === true };
    },
  },
  {
    name: 'merge_pull_request',
    description: "Merge a task's open pull request: pulls the target branch into the task branch (Claude Code resolves conflicts, keeping the changes other tasks merged), pushes and merges it, then moves the task to Done. Takes a while when there are conflicts.",
    inputSchema: {
      type: 'object',
      properties: { taskId: TASK_ID, targetBranch: { type: 'string', description: "Branch to merge into (default: the PR's base)" } },
      required: ['taskId'],
    },
    mutates: true,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      const result = await ipc<WorktreeMergePRResult>(IPC_CHANNELS.TASK_WORKTREE_MERGE_PR, task.id, { targetBranch: text(args.targetBranch) }, context.projectId);
      if (!result.success) throw new Error(result.error || 'The pull request could not be merged');
      return { id: task.id, ...result };
    },
  },
  {
    name: 'archive_tasks',
    description: 'Archive tasks: they leave the board but are kept (unarchive_tasks brings them back).',
    inputSchema: { type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' } } }, required: ['taskIds'] },
    mutates: true,
    run: async (context, args) => {
      const ids = (Array.isArray(args.taskIds) ? args.taskIds : []).map((id) => findTask(context, id).id);
      if (ids.length === 0) throw new Error('taskIds is required');
      await ipc(IPC_CHANNELS.TASK_ARCHIVE, context.projectId, ids);
      return { archived: ids };
    },
  },
  {
    name: 'unarchive_tasks',
    description: 'Bring archived tasks back to the board.',
    inputSchema: { type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' } } }, required: ['taskIds'] },
    mutates: true,
    run: async (context, args) => {
      const ids = (Array.isArray(args.taskIds) ? args.taskIds : []).map((id) => findTask(context, id).id);
      if (ids.length === 0) throw new Error('taskIds is required');
      await ipc(IPC_CHANNELS.TASK_UNARCHIVE, context.projectId, ids);
      return { unarchived: ids };
    },
  },
  {
    name: 'message_task',
    description:
      'Send a short message from the user to a task. A running task reads it at its next step; a task between steps, queued or ' +
      'not started reads it when it next runs. Use it to tell a task something it should take into account, not to change what ' +
      'it was asked to do (use update_task or request_changes for that). Returns what happened: delivered, queued or not sent (and why).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        message: { type: 'string', description: `The message, up to ${MAX_MESSAGE_LENGTH} characters. Plain text, specific and brief` },
      },
      required: ['taskId', 'message'],
    },
    mutates: false,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      const message = typeof args.message === 'string' ? args.message : '';
      const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
      if (!resolveClaudeCodeTaskSettings(settings.claudeCodeTasks).taskMessaging) {
        return { task: task.id, status: 'refused', detail: 'not sent: Task messaging is off in Settings > Agents' };
      }
      if (!message.trim()) return { task: task.id, status: 'refused', detail: 'not sent: the message is empty' };
      if (message.trim().length > MAX_MESSAGE_LENGTH) {
        return { task: task.id, status: 'refused', detail: `not sent: the message is longer than ${MAX_MESSAGE_LENGTH} characters` };
      }
      const outcome = await deliverToTask(context.projectId, task, { kind: 'user' }, message.trim());
      return { task: task.id, status: outcome.status, detail: outcome.detail };
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task with its files, worktree and branch. This cannot be undone: only when the user explicitly asked to delete it.',
    inputSchema: { type: 'object', properties: { taskId: TASK_ID }, required: ['taskId'] },
    mutates: true,
    run: async (context, args) => {
      const task = findTask(context, args.taskId);
      await ipc(IPC_CHANNELS.TASK_DELETE, task.id, context.projectId);
      return { deleted: task.id };
    },
  },
];

/** Run a task tool; tasks changed by it are reloaded on the board even when it fails midway */
export async function runTaskTool(context: TaskToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = TASK_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  try {
    return await tool.run(context, args ?? {});
  } finally {
    if (tool.mutates) context.onTasksChanged();
  }
}
