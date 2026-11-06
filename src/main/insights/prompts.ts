/**
 * Insights prompts
 * ================
 *
 * System prompt, conversation folding and task-suggestion parsing for the Insights chat.
 */

import { TASK_SUGGESTION_PREFIX } from '../../shared/utils/task-suggestions';
import { SELF_IMPROVE_NUDGE } from '../self-improve/nudge';
import { DATA_DIR_NAMES } from '../../shared/constants';

/** A message in the insights conversation history */
export interface InsightsMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type { TaskSuggestion } from '../../shared/utils/task-suggestions';

/** Fold the conversation history into a single prompt (each turn is a fresh run) */
export function buildConversationPrompt(message: string, history: InsightsMessage[] = []): string {
  if (history.length === 0) return message;
  const conversationContext = history
    .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
    .join('\n\n');
  return `Previous conversation:\n${conversationContext}\n\nCurrent question: ${message}`;
}

/** Git hosting CLIs Claude may use in the conversation (the GitHub and GitLab buttons) */
export interface InsightsCliTools {
  github?: boolean;
  gitlab?: boolean;
}

/**
 * The `gh` commands the GitHub button allows: reading only. Each is allowed with any arguments
 * (`Bash(<command>:*)`); every other `gh` command (checkout, sync, download, create, comment,
 * merge, api, alias, extension...) is denied. None writes files, changes git state or the remote,
 * or needs a terminal; `--web` only opens the browser
 */
export const INSIGHTS_GITHUB_COMMANDS = [
  'gh pr view',
  'gh pr list',
  'gh pr diff',
  'gh pr checks',
  'gh pr status',
  'gh issue view',
  'gh issue list',
  'gh issue status',
  'gh run list',
  'gh run view',
  'gh workflow list',
  'gh workflow view',
  'gh release list',
  'gh release view',
  'gh repo view',
  'gh label list',
  'gh search',
  'gh status',
] as const;

/**
 * The `glab` commands the GitLab button allows: reading only, as for `gh`. `glab ci status` and
 * `glab ci view` are left out: they can offer to retry or cancel jobs
 */
export const INSIGHTS_GITLAB_COMMANDS = [
  'glab mr view',
  'glab mr list',
  'glab mr diff',
  'glab mr issues',
  'glab issue view',
  'glab issue list',
  'glab ci list',
  'glab ci get',
  'glab ci trace',
  'glab release list',
  'glab release view',
  'glab repo view',
  'glab label list',
] as const;

/** What the chat's Claude Code run is given, which the system prompt describes */
export interface InsightsPromptOptions {
  /** The Kanban button: Workbench's task tools */
  taskTools?: boolean;
  /** The GitHub and GitLab buttons */
  cliTools?: InsightsCliTools;
  /** The project's memory graph: Bash for graphify searches (described in their own section) */
  graphify?: boolean;
  /** Names of the MCP servers chosen with the MCP button */
  mcpServers?: string[];
  /** Self-improve is on: Claude may save project memories, and only those */
  memory?: boolean;
  /** ListAgents and SendMessage, to reach other running Claude Code sessions (with the task tools) */
  sessionMessaging?: boolean;
  /** Task messaging is on: message_task delivers (with the task tools) */
  taskMessaging?: boolean;
  /** Playwright works in the chat's own browser, which the user sees and uses in the browser drawer */
  sharedBrowser?: boolean;
}

/** The suggestion line's format, as Claude must write it */
const SUGGESTION_FORMAT = `${TASK_SUGGESTION_PREFIX}{"title": "Task title", "description": "What the task involves, with what Claude Code needs to do it"}`;

/** How to suggest a task (the app turns the line into a card with a Create task button) */
const SUGGESTING_TASKS = `Suggest a task with a line at the very end of your reply, one line per suggestion and at most three, in exactly this format:
${SUGGESTION_FORMAT}
Each line is one JSON object on a single line: write line breaks in the description as \\n. The app shows the line as a card with a Create task button and hides the line itself, so do not refer to it or repeat its text.`;

/** What Claude can do with the git hosting CLIs turned on for the conversation */
function cliToolsPrompt(cliTools: InsightsCliTools): string {
  const clis = [
    ...(cliTools.github ? ['the GitHub CLI (`gh`)'] : []),
    ...(cliTools.gitlab ? ['the GitLab CLI (`glab`)'] : []),
  ];
  if (clis.length === 0) return '';
  const heading = [...(cliTools.github ? ['GitHub'] : []), ...(cliTools.gitlab ? ['GitLab'] : [])].join(' and ');
  const commands = [
    ...(cliTools.github ? INSIGHTS_GITHUB_COMMANDS : []),
    ...(cliTools.gitlab ? INSIGHTS_GITLAB_COMMANDS : []),
  ].map((command) => `\`${command}\``);
  return `

## ${heading}
You can use ${clis.join(' and ')} through Bash to read the project's repository: pull or merge requests and their diffs and checks, issues, CI runs and their logs, releases, repository info and search. Only these commands are allowed, with any arguments: ${commands.join(', ')}.
- Everything else is denied: checking out or syncing branches, downloading files, creating, editing, commenting on, reviewing, closing or merging anything, \`api\` calls, aliases and extensions. When the user wants one of those, tell them to do it themselves or do it through a task.
- Writing a command's output to a file is denied; piping it into \`head\` or \`grep\` works, and \`--jq\` picks fields from JSON output.
- When a command fails (not installed, not signed in, no access), say so instead of trying something else.`;
}

/** The tools the turn has, so Claude neither reaches for missing ones nor overlooks given ones */
function toolsPrompt(options: InsightsPromptOptions): string {
  const commands = [
    ...(options.graphify ? ['the graphify searches described below'] : []),
    ...(options.cliTools?.github ? ['the `gh` commands listed below'] : []),
    ...(options.cliTools?.gitlab ? ['the `glab` commands listed below'] : []),
  ];
  const servers = options.mcpServers ?? [];
  return [
    '## What you can use',
    `- Read, Glob and Grep for the project's files. You can't change them${options.memory ? ' (except your project memory, below)' : ''}: code changes are made by tasks.`,
    commands.length > 0
      ? `- Bash, only for ${commands.join(' and ')}. Every other shell command is denied.`
      : '- No shell commands.',
    ...(servers.length > 0
      ? [`- MCP servers the user turned on for this chat: ${servers.join(', ')} (tools named mcp__<server>__<tool>). Use them when they fit the question.`]
      : []),
    ...(options.sharedBrowser && servers.includes('playwright')
      ? ["- Playwright works in this chat's own browser, which the user watches and uses too, in Workbench's browser drawer. It stays open between messages with its tabs and sign-ins, and the user may have opened a page or signed in for you: look at its tabs (browser_tabs) before navigating away, and leave it open. When a step needs the user (a sign-in, a multi-factor code, a captcha), ask them to do it in the drawer and tell you when they are done."]
      : []),
    '- WebSearch and WebFetch for the web: documentation, release notes, issues and anything else outside the project.',
    "- Files attached to the current message are part of it. Earlier messages note [User previously attached N file(s)]: those files aren't visible any more, so ask for them again when you need them.",
  ].join('\n');
}

/** Working with the project's tasks: with the Kanban button's task tools, or by suggesting them */
function tasksPrompt(options: InsightsPromptOptions): string {
  const tasksDir = `.workbench/${DATA_DIR_NAMES.tasks}`;
  if (options.taskTools) {
    return `## Tasks
You can manage the project's tasks with the Workbench task tools (mcp__workbench__*): list and inspect tasks (status, plan, logs, validation, worktree changes), create and edit them, start, stop and retry them, move them between columns, request changes, create and merge their pull requests, archive and delete them. To get something done, create a task whose description gives Claude Code everything it needs, and start it when the user wants it done now.
- Act on what the user asks for, and tell them what you did (with the task ids). Look tasks up with list_tasks or get_task instead of guessing ids or states.
- Delete tasks, retry them (it discards their changes) or merge pull requests only when the user asked for exactly that. When moving a task with a worktree to Done, ask whether to keep or delete the worktree.
- When a tool fails, explain why instead of trying something else the user didn't ask for.
${options.taskMessaging ? '- To tell a task something it should take into account while it works, use message_task: a running task reads it at its next step, any other task when it next runs.' : '- Task messaging is off in Settings > Agents, so message_task can\'t reach tasks: to change what a task does, use update_task or request_changes.'}${options.sessionMessaging ? ' To reach another running Claude Code session, such as one of the user\'s agent windows, use SendMessage with a name from ListAgents (tasks are the wb-… sessions, but use message_task for them). Messages are plain text, and replies can\'t reach this chat.' : ''}
- When you notice something worth doing that the user did not ask for (a bug you came across, a feature, a docs update, a refactor), don't create it. Suggest it instead so the user decides.

${SUGGESTING_TASKS}`;
  }
  return `## Tasks
You can't create or change tasks in this conversation (the user turns that on with the Kanban button). The project's tasks are in ${tasksDir}/<id>/ (task_metadata.json, and implementation_plan.json with the status): look there before suggesting one, so you don't suggest a task that already exists.

When the user asks you to create a task or to turn the conversation into one, or when you believe a task would be useful (a bug you came across, a feature, a docs update, a refactor, anything a task could do), suggest it.

${SUGGESTING_TASKS}`;
}

/** System prompt of a Claude page turn (appended to Claude Code's own) */
export function buildSystemPrompt(options: InsightsPromptOptions = {}): string {
  return `You are the Claude page of Workbench, a desktop app where Claude Code does coding tasks autonomously, each in its own git worktree, while the user follows them on a Kanban board (Planning, Queue, In Progress, AI Review, Human Review, Done). Here the user talks with you about this project: its code and architecture, what to build next, and the state of its work.

Your replies appear as Markdown in a narrow chat panel. Lead with the answer, keep it short, and use lists, tables and code blocks only where they make it clearer. Base answers on the project's actual code: look things up instead of guessing.

${toolsPrompt(options)}

${tasksPrompt(options)}${cliToolsPrompt(options.cliTools ?? {})}${options.memory ? `\n\n${SELF_IMPROVE_NUDGE}` : ''}`;
}

/** Brief description of a tool call's arguments for UI display */
export function extractToolInput(args: Record<string, unknown>): string {
  // Bash (graphify searches, gh and glab): the whole command; the chat cuts it to its row
  if (args.command) return capToolInput(String(args.command));
  if (args.pattern) return `pattern: ${args.pattern}`;
  if (args.file_path) return capToolInput(String(args.file_path));
  if (args.path) return String(args.path);
  // Task tools: the task (and where it goes) or the new task's title
  if (args.taskId) return args.to ? `${args.taskId} → ${args.to}` : String(args.taskId);
  if (Array.isArray(args.taskIds)) return args.taskIds.join(', ');
  if (args.title) return String(args.title);
  if (args.description) return capToolInput(String(args.description));
  return '';
}

/** Longest tool input kept (on its first line); the chat shows what fits on a row */
const TOOL_INPUT_MAX = 500;

function capToolInput(value: string): string {
  const firstLine = value.split('\n', 1)[0];
  const capped = firstLine.length > TOOL_INPUT_MAX ? firstLine.slice(0, TOOL_INPUT_MAX) : firstLine;
  return capped.length < value.length ? `${capped}…` : capped;
}
