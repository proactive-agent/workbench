/**
 * Workbench tools of a task run
 * =============================
 *
 * The MCP tools a task's Claude Code session gets (server `workbench`, tools
 * `mcp__workbench__<name>`), served by the app's local tools server with a token per run:
 *
 *   message_task         send a message to another task of the project
 *   list_parallel_tasks  the project's other unmerged tasks: status, session, files, live or not
 */
import { taskSessionName } from '../../shared/utils/task-messaging';
import type { TaskStatus } from '../../shared/types';
import { foldTaskChangelog, getTaskChangelogPath, readTaskChangelog } from '../task-changelog';
import { MAX_MESSAGE_LENGTH, deliver, getTaskMessagingEnv, isTaskLive, statusLabel } from './broker';

export interface TaskRunToolContext {
  projectId: string;
  /** The task whose session calls the tools */
  specId: string;
}

/** Tool names as the session sees them, for `--allowedTools` (plan mode needs them pre-approved) */
export const TASK_RUN_TOOL_NAMES = ['message_task', 'list_parallel_tasks'] as const;

const PARALLEL_STATUSES = new Set<TaskStatus>(['queue', 'in_progress', 'ai_review', 'human_review', 'pr_created', 'error']);
const MAX_FILES = 40;

export interface TaskRunTool {
  name: (typeof TASK_RUN_TOOL_NAMES)[number];
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  run: (context: TaskRunToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

async function messageTask(context: TaskRunToolContext, args: Record<string, unknown>): Promise<string> {
  const target = typeof args.task === 'string' ? args.task : '';
  const message = typeof args.message === 'string' ? args.message : '';
  if (!target.trim()) return 'not sent: say which task (its id, number or session name)';
  const env = getTaskMessagingEnv();
  const me = env?.getTasks(context.projectId).find((t) => t.specId === context.specId);
  const outcome = await deliver(context.projectId, target, {
    kind: 'task',
    specId: context.specId,
    title: me?.title,
    sessionName: taskSessionName(context.projectId, context.specId),
  }, message);
  return outcome.detail;
}

async function listParallelTasks(context: TaskRunToolContext): Promise<unknown> {
  const env = getTaskMessagingEnv();
  const project = env?.getProject(context.projectId);
  if (!env || !project) return { tasks: [], note: 'The project is not open in Workbench' };
  const fold = project.autoBuildPath
    ? foldTaskChangelog(await readTaskChangelog(getTaskChangelogPath(project.path, project.autoBuildPath)))
    : new Map();
  const tasks = env.getTasks(context.projectId)
    .filter((t) => t.specId !== context.specId && PARALLEL_STATUSES.has(t.status) && !t.metadata?.archivedAt)
    .map((t) => {
      const files: string[] = fold.get(t.specId)?.files ?? [];
      return {
        task: t.specId,
        title: t.title,
        status: statusLabel(t.status),
        session: taskSessionName(context.projectId, t.specId),
        runningNow: isTaskLive(context.projectId, t.specId),
        baseBranch: t.metadata?.baseBranch || project.settings?.mainBranch || undefined,
        files: files.slice(0, MAX_FILES),
        ...(files.length > MAX_FILES ? { moreFiles: files.length - MAX_FILES } : {}),
      };
    });
  return {
    you: { task: context.specId, session: taskSessionName(context.projectId, context.specId) },
    tasks,
    ...(tasks.length === 0 ? { note: 'No other task has unmerged changes right now' } : {}),
  };
}

export const TASK_RUN_TOOLS: TaskRunTool[] = [
  {
    name: 'message_task',
    description:
      'Send a short message to another task of this project. Workbench delivers it whatever state the task is in: ' +
      'a running task reads it at its next step, a task between steps or not started reads it when it next runs. Use it when your change affects ' +
      "files, APIs or schemas the other task works with, when you are blocked on something it will settle, or to answer a question it sent you. " +
      'Returns what happened: delivered, queued or not sent (and why).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task: its id ("012-add-login"), number ("012"), or session name ("wb-…")' },
        message: { type: 'string', description: `The message, up to ${MAX_MESSAGE_LENGTH} characters. Be specific and brief` },
      },
      required: ['task', 'message'],
      additionalProperties: false,
    },
    // It never changes the project's files, and plan mode only lets read-only tools run
    readOnly: true,
    run: messageTask,
  },
  {
    name: 'list_parallel_tasks',
    description:
      "The project's other tasks whose changes are not merged yet: id, title, status, session name, whether it runs right now, its base branch " +
      'and the files its branch changes. Use it to see where your work meets another task\'s: shared files are fine (only edits to the same lines conflict), ' +
      'so agree with a task via message_task when you both need to change the same code.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    run: (context) => listParallelTasks(context),
  },
];

/** Run a task-run tool; unknown tools throw */
export async function runTaskRunTool(context: TaskRunToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = TASK_RUN_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(context, args);
}
