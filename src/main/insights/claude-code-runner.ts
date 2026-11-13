/**
 * Insights via Claude Code
 * ========================
 *
 * Every Insights turn runs through the locally installed Claude Code CLI in headless mode
 * (`claude -p --output-format stream-json --include-partial-messages`), so text streams
 * into the chat as it is written.
 *
 * By default the CLI can't change the project's files: only Read/Glob/Grep, WebFetch/WebSearch (plus Bash limited to graphify's
 * read-only searches when the project's memory graph is on, and to read-only `gh` / `glab`
 * commands when the GitHub / GitLab buttons are on) are available, and the MCP servers are
 * Workbench's task tools (`task-tools-server.ts`), so Claude can manage the project's tasks, and
 * the ones chosen for the chat. Anything else is denied without prompting
 * (`--permission-mode dontAsk`). With the Clawd button on (`agentMode`) a turn gets what an agent
 * window has instead: every tool, the user's own MCP servers besides the chat's, and the agent
 * windows' permissions (skipped when Settings skips them, else Claude Code's auto mode, since a
 * headless turn can't ask). Each chat is a Claude Code session (see InsightsSessionPlan). Credentials come from the best available Claude profile or the active API profile
 * (`resolveClaudeEnv`).
 */

import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { makeTempFolder, noteTempFolderRun, removeTempFolder, TEMP_FOLDER_PREFIXES } from '../temp-folders';
import { dirname, join } from 'node:path';
import { resolveClaudeEnv } from '../claude-code/env';
import { startClaudeProcess } from '../claude-code/process';
import type { ClaudeStreamMessage, ClaudeUserContentBlock } from '../claude-code/stream-types';
import { getToolInfoAsync } from '../cli-tool-manager';
import { getPathDelimiter } from '../platform';
import { getShellRuntimeStatus, getWslInfo, toRuntimePath, whenShellRuntimeReady } from '../platform/shell-runtime';
import { appLog } from '../app-logger';
import { INSIGHTS_ERROR_CODES, formatInsightsError } from '../../shared/constants/insights';
import { CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES } from '../../shared/types/claude-code';
import type { ClaudeEffort, ClaudeModelAlias } from '../../shared/types/claude-code';
import type { ImageAttachment } from '../../shared/types';
import type { GraphifyAgentContext } from '../graphify';
import type { InsightsCliTools } from './prompts';
import { randomUUID } from 'node:crypto';
import semver from 'semver';
import { extractTaskSuggestions, stripTaskSuggestions } from '../../shared/utils/task-suggestions';
import { COMPENG_DIR_NAME } from '../self-improve/paths';
import type { ClaudeSessionRef } from '../../shared/types';
import { MCP_STARTUP_TIMEOUT_MS, type ClaudeMcpConfig, type McpServerEntry } from '../claude-code/mcp-config';
import { PLAYWRIGHT_MCP_PACKAGE } from '../browser-profiles/managed';
import { registerChatBrowserWorkspace } from '../browser-drawer/project-match';
import { TASK_TOOLS_SERVER_NAME, toBridgeServer, type TaskToolsMcpServer, type TaskToolsStdioServer } from './task-tools-mcp';
// The bridge's source, bundled as text and written next to the turn's other temp files
import TASK_TOOLS_BRIDGE_SOURCE from './task-tools-bridge.cjs?raw';
import PLAYWRIGHT_GUARD_SOURCE from './playwright-guard.cjs?raw';
import { buildMessageContent } from './message-content';
import {
  INSIGHTS_GITHUB_COMMANDS,
  INSIGHTS_GITLAB_COMMANDS,
  buildConversationPrompt,
  buildSystemPrompt,
  extractToolInput,
  type InsightsMessage,
  type TaskSuggestion,
} from './prompts';

// =============================================================================
// Types
// =============================================================================

/** Configuration for one Insights turn */
export interface InsightsRunConfig {
  projectDir: string;
  /** User message to process */
  message: string;
  /** Previous conversation history */
  history?: InsightsMessage[];
  /** Model (Claude alias or full model ID, defaults to 'sonnet') */
  model?: string;
  /** Thinking level / effort (defaults to 'medium') */
  thinkingLevel?: string;
  abortSignal?: AbortSignal;
  /** Files attached to the current message (images, PDFs, text/code files) */
  attachments?: ImageAttachment[];
  /** The project's memory graph, when its "Use Graphify" setting is on */
  graphify?: GraphifyAgentContext;
  /** The project's Claude account (Settings > Project); unset = the account in use */
  profileId?: string;
  /** MCP server entry of the turn's Workbench tools (task tools and/or messaging tools) */
  taskTools?: TaskToolsMcpServer;
  /** The Workbench tools include the task tools (the Kanban button); unset: they do */
  kanbanTools?: boolean;
  /**
   * The chat's stable name, when its Workbench tools include messaging the project's other chats
   * and agent windows (session-messaging/tools.ts)
   */
  chatName?: string;
  /** MCP servers chosen for the chat (the MCP button), by server name */
  mcpServers?: ClaudeMcpConfig['mcpServers'];
  /** Git hosting CLIs turned on for the chat (the GitHub and GitLab buttons) */
  cliTools?: InsightsCliTools;
  /** The project's self-improve switch is on: Claude may save project memories (and only those) */
  memory?: boolean;
  /** Which Claude Code session the turn runs in (a new one unless given) */
  session?: InsightsSessionPlan;
  /** The chat's title, shown in Claude Code's session list for a new session */
  title?: string;
  /**
   * The user's sessions may message each other (Settings > Agents): the chat gets Claude Code's
   * ListAgents and SendMessage for other running sessions (agent windows, tasks)
   */
  sessionMessages?: boolean;
  /** Task messaging is on (Settings > Agents): the prompt tells the chat about message_task */
  taskMessaging?: boolean;
  /** Playwright attaches to the chat's own browser (shared with the user in the browser drawer) */
  sharedBrowser?: boolean;
  /**
   * The Clawd button: the turn gets what an agent window has (see buildInsightsArgs).
   * `skipPermissions`: agent windows skip permission prompts (Settings)
   */
  agentMode?: { skipPermissions: boolean };
}

/**
 * The Claude Code session a turn runs in:
 * - new: a fresh session, with the conversation so far folded into the prompt (the first message,
 *   or when the earlier session can't be continued)
 * - resume: the chat's session, continued from its end
 * - fork: a copy of the chat's session cut at an earlier reply (after an edit or regenerate
 *   dropped what followed it); the original session is left as it was
 * Resume and fork run on the account that holds the session's transcript.
 */
export type InsightsSessionPlan =
  | { mode: 'new' }
  | { mode: 'resume'; sessionId: string; profileId?: string }
  | { mode: 'fork'; sessionId: string; atMessageUuid: string; profileId?: string };

/** Info about a tool call made during the turn */
interface ToolCallInfo {
  name: string;
  input: string;
}

/** Result of an Insights turn */
export interface InsightsResult {
  /** The reply, without its task suggestion lines */
  text: string;
  /** The tasks the reply suggests (each was a suggestion line) */
  taskSuggestions: TaskSuggestion[];
  /** Where the reply ends in its Claude Code session, for the next turn to resume or fork */
  claudeRef?: ClaudeSessionRef;
  toolCalls: ToolCallInfo[];
}

/** Events emitted while a turn streams */
export type InsightsStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; input: string }
  | { type: 'tool-end'; name: string }
  | { type: 'error'; error: string };

export type InsightsStreamCallback = (event: InsightsStreamEvent) => void;

/** Error raised when the model finishes without producing any answer text */
const EMPTY_RESPONSE_ERROR = 'The model returned an empty response';

/** Tools the Insights agent may use (read-only codebase exploration) */
export const INSIGHTS_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/** Claude Code's web tools; they ask for permission, so they are allowed outright too */
export const INSIGHTS_WEB_TOOLS = ['WebFetch', 'WebSearch'] as const;

/**
 * Bash commands allowed for searching the project's memory graph (graphify's read-only
 * searches); every other Bash command is denied
 */
export const INSIGHTS_GRAPHIFY_COMMANDS = [
  'Bash(graphify query:*)',
  'Bash(graphify explain:*)',
  'Bash(graphify path:*)',
  'Bash(graphify affected:*)',
  'Bash(graphify god-nodes:*)',
] as const;

// =============================================================================
// Arguments
// =============================================================================

/** Claude Code model alias for a stored Insights model (legacy full IDs map to their family) */
export function toClaudeModel(model: string | undefined): string {
  if (!model) return 'sonnet';
  if ((CLAUDE_MODEL_ALIASES as readonly string[]).includes(model)) return model as ClaudeModelAlias;
  if (model.startsWith('claude-')) return model;
  for (const alias of CLAUDE_MODEL_ALIASES) {
    if (model.toLowerCase().includes(alias)) return alias;
  }
  return 'sonnet';
}

/** Claude Code effort for a stored thinking level */
function toClaudeEffort(level: string | undefined): ClaudeEffort {
  return level && (CLAUDE_EFFORTS as readonly string[]).includes(level) ? (level as ClaudeEffort) : 'medium';
}

/** Where a chat may write: the project memory (self-improve), relative to the project */
export const INSIGHTS_MEMORY_RULE = `Edit(.workbench/${COMPENG_DIR_NAME}/**)`;

/**
 * Bash rules for the git hosting CLIs (the GitHub and GitLab buttons): their read-only commands,
 * each with any arguments. A bare `Bash(gh:*)` would let Claude check out branches, download
 * files, call the API or run aliases and extensions (arbitrary commands) without asking
 */
export const INSIGHTS_GITHUB_RULES = INSIGHTS_GITHUB_COMMANDS.map((command) => `Bash(${command}:*)`);
export const INSIGHTS_GITLAB_RULES = INSIGHTS_GITLAB_COMMANDS.map((command) => `Bash(${command}:*)`);

/** First Claude Code version with `--system-prompt-snapshot` (CHANGELOG 2.1.267) */
export const SYSTEM_PROMPT_SNAPSHOT_MIN_VERSION = '2.1.267';

/** Whether a Claude Code version (as `claude --version` prints it) knows `--system-prompt-snapshot` */
export function supportsSystemPromptSnapshot(version: string | null | undefined): boolean {
  const parsed = version ? semver.coerce(version) : null;
  return !!parsed && semver.gte(parsed, SYSTEM_PROMPT_SNAPSHOT_MIN_VERSION);
}

/** Claude Code's built-in messaging between running sessions */
export const INSIGHTS_SESSION_MESSAGING_TOOLS = ['ListAgents', 'SendMessage'] as const;

/** MCP tools rule for Workbench's task tools (every tool of the server) */
export const INSIGHTS_TASK_TOOLS_RULE = `mcp__${TASK_TOOLS_SERVER_NAME}`;

/** How long a task tool may run (merging a PR with conflicts takes a while) */
const TASK_TOOL_TIMEOUT_MS = 45 * 60 * 1000;

/** The turn's MCP servers: the config file, and which of its servers Claude may use */
export interface InsightsMcpArgs {
  configFile: string;
  /** Workbench's task tools are in the file */
  taskTools: boolean;
  /** Names of the chat's other MCP servers in the file */
  servers: string[];
  /**
   * Folders the turn may read besides the project (where tools run): its Playwright folder, which
   * tool results link to (snapshots, screenshots)
   */
  readDirs?: string[];
}

/**
 * The session flags of a turn. A fork uses `--resume-session-at`, which the Agent SDK uses for
 * its resumeSessionAt option (not listed by `claude --help`): the session up to and including
 * that assistant message, copied to a new session by `--fork-session`
 */
export function sessionArgs(plan: InsightsSessionPlan, newSessionId: string, title?: string): string[] {
  if (plan.mode === 'resume') return ['--resume', plan.sessionId];
  if (plan.mode === 'fork') return ['--resume', plan.sessionId, '--resume-session-at', plan.atMessageUuid, '--fork-session'];
  return ['--session-id', newSessionId, ...(title ? ['--name', `Workbench chat: ${title}`] : [])];
}

/**
 * CLI arguments for a headless turn that can't change the project's files.
 * `systemPromptSnapshot`: the CLI knows `--system-prompt-snapshot` (see supportsSystemPromptSnapshot).
 * `sessionMessaging`: ListAgents and SendMessage, to reach other running sessions (agent windows,
 * tasks); they never change the project's files.
 * `agentMode` (the Clawd button): what an agent window has instead. Every tool (no `--tools`), the
 * user's own MCP servers too (no `--strict-mcp-config`), and the agent windows' permissions:
 * skipped when Settings skips them, else Claude Code's auto mode (a classifier reviews each action),
 * since a headless turn can't ask. The chat's allowed rules still pre-approve its MCP servers
 */
export function buildInsightsArgs(
  model: string,
  effort: ClaudeEffort,
  systemPromptFile: string,
  withGraphify = false,
  mcp?: InsightsMcpArgs,
  cliTools: InsightsCliTools = {},
  memory = false,
  session: string[] = [],
  systemPromptSnapshot = false,
  sessionMessaging = false,
  agentMode?: { skipPermissions: boolean },
): string[] {
  const cliRules = [
    ...(cliTools.github ? INSIGHTS_GITHUB_RULES : []),
    ...(cliTools.gitlab ? INSIGHTS_GITLAB_RULES : []),
  ];
  const withBash = withGraphify || cliRules.length > 0;
  const tools = [
    ...INSIGHTS_READ_ONLY_TOOLS,
    ...INSIGHTS_WEB_TOOLS,
    ...(withBash ? ['Bash'] : []),
    // Saving memories; every other write is denied (dontAsk allows only the rule below)
    ...(memory ? ['Write', 'Edit'] : []),
    ...(sessionMessaging ? INSIGHTS_SESSION_MESSAGING_TOOLS : []),
  ];
  const allowed = [
    ...(memory ? [INSIGHTS_MEMORY_RULE] : []),
    ...(withGraphify ? INSIGHTS_GRAPHIFY_COMMANDS : []),
    ...cliRules,
    ...(mcp?.taskTools ? [INSIGHTS_TASK_TOOLS_RULE] : []),
    ...(mcp?.servers ?? []).map((server) => `mcp__${server}`),
    ...INSIGHTS_WEB_TOOLS,
    ...(sessionMessaging ? INSIGHTS_SESSION_MESSAGING_TOOLS : []),
  ];
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--effort', effort,
    ...(agentMode ? [] : ['--tools', tools.join(',')]),
    '--allowedTools', ...allowed,
    // Also left out by the Playwright guard: Node.js code in the server, which could write anywhere
    ...(mcp?.servers.includes('playwright') ? ['--disallowedTools', 'mcp__playwright__browser_run_code_unsafe'] : []),
    ...(mcp?.readDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
    ...(!agentMode
      ? ['--permission-mode', 'dontAsk', '--strict-mcp-config']
      : agentMode.skipPermissions ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'auto']),
    ...(mcp ? ['--mcp-config', mcp.configFile] : []),
    ...session,
    '--append-system-prompt-file', systemPromptFile,
    // Claude Code records a session's system prompt on its first request and resends that record
    // on every resume and fork; each turn's prompt describes what that turn is given, so it must
    // be sent fresh (the flag is passed only to versions that know it)
    ...(systemPromptSnapshot ? ['--system-prompt-snapshot', 'off'] : []),
  ];
}

// =============================================================================
// Stream handling
// =============================================================================

interface StreamState {
  text: string;
  toolCalls: ToolCallInfo[];
  /** tool_use id → tool name, for matching tool results */
  toolNames: Map<string, string>;
  /** Content block index → in-progress tool call */
  pendingTools: Map<number, { id: string; name: string; json: string }>;
  result?: { isError: boolean; subtype?: string; text?: string };
  /** The Claude Code session the turn ran in (from its init or result message) */
  sessionId?: string;
  /** The turn's last assistant message, where a later fork can cut the session */
  lastAssistantUuid?: string;
  /**
   * The last message the turn wrote to its session (a slash command's output, a compact boundary):
   * the session's point after a turn with no assistant message
   */
  lastUuid?: string;
  /** What a local slash command printed (`/compact`'s "Compacted"), its reply when no text came */
  localOutput?: string;
}

/** A local slash command's output, from the user message Claude Code records it in */
function localCommandOutput(content: unknown): string | undefined {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Array<{ type?: string; text?: string }>).map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('')
      : '';
  const match = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
  return match ? match[1].trim() : undefined;
}

function createStreamState(): StreamState {
  return { text: '', toolCalls: [], toolNames: new Map(), pendingTools: new Map() };
}

/** Apply one stream-json message from the CLI to the turn state, emitting UI events */
function handleInsightsEvent(
  event: ClaudeStreamMessage | Record<string, unknown>,
  state: StreamState,
  onStream?: InsightsStreamCallback,
): void {
  const raw = event as Record<string, unknown>;
  if (typeof raw.session_id === 'string' && (raw.type === 'system' || raw.type === 'result')) state.sessionId = raw.session_id;
  if (typeof raw.uuid === 'string' && (raw.type === 'assistant' || raw.type === 'user' || raw.subtype === 'compact_boundary')) {
    state.lastUuid = raw.uuid;
  }
  switch (raw.type) {
    case 'assistant': {
      if (typeof raw.uuid === 'string') state.lastAssistantUuid = raw.uuid;
      break;
    }
    case 'stream_event': {
      const inner = raw.event as Record<string, unknown> | undefined;
      const index = inner?.index as number | undefined;
      if (inner?.type === 'content_block_start') {
        const block = inner.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === 'tool_use' && index !== undefined) {
          state.pendingTools.set(index, { id: block.id ?? '', name: block.name ?? 'tool', json: '' });
        } else if (block?.type === 'text' && state.text) {
          // Separate text written before and after tool use
          state.text += '\n\n';
          onStream?.({ type: 'text-delta', text: '\n\n' });
        }
      } else if (inner?.type === 'content_block_delta') {
        const delta = inner.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (delta?.type === 'text_delta' && delta.text) {
          state.text += delta.text;
          onStream?.({ type: 'text-delta', text: delta.text });
        } else if (delta?.type === 'input_json_delta' && index !== undefined) {
          const pending = state.pendingTools.get(index);
          if (pending) pending.json += delta.partial_json ?? '';
        }
      } else if (inner?.type === 'content_block_stop' && index !== undefined) {
        const pending = state.pendingTools.get(index);
        if (pending) {
          state.pendingTools.delete(index);
          let args: Record<string, unknown> = {};
          try {
            args = pending.json ? (JSON.parse(pending.json) as Record<string, unknown>) : {};
          } catch {
            // Keep empty args if the CLI sent malformed partial JSON
          }
          const input = extractToolInput(args);
          state.toolNames.set(pending.id, pending.name);
          state.toolCalls.push({ name: pending.name, input });
          onStream?.({ type: 'tool-start', name: pending.name, input });
        }
      }
      break;
    }
    case 'user': {
      const content = (raw.message as { content?: unknown } | undefined)?.content;
      const output = localCommandOutput(content);
      if (output !== undefined) state.localOutput = output;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; tool_use_id?: string }>) {
          if (block.type === 'tool_result') {
            onStream?.({ type: 'tool-end', name: state.toolNames.get(block.tool_use_id ?? '') ?? 'tool' });
          }
        }
      }
      break;
    }
    case 'result': {
      const errors = Array.isArray(raw.errors) ? (raw.errors as string[]).join('; ') : '';
      state.result = {
        isError: raw.is_error === true || (typeof raw.subtype === 'string' && raw.subtype !== 'success'),
        subtype: raw.subtype as string | undefined,
        text: typeof raw.result === 'string' && raw.result ? raw.result : errors || undefined,
      };
      break;
    }
  }
}

// =============================================================================
// Runner
// =============================================================================

/**
 * How Claude Code reaches the turn's task tools, served over HTTP on the host's 127.0.0.1:
 * - 'direct': natively, inside WSL1 (it shares the host's localhost) and inside WSL2 with
 *   mirrored networking and interop off (no bridge: a firewall rule may let it through)
 * - 'bridge': inside WSL2, through the stdio bridge (task-tools-bridge.cjs) that Claude Code starts
 *   as a Windows process through WSL interop. NAT networking gives the distribution its own
 *   localhost; with mirrored networking the Hyper-V firewall blocks inbound connections from the
 *   distribution by default (Windows' own loopback ports time out), so the bridge is used there too
 * - 'off': WSL2 with NAT networking and interop off (the probe says so), or the bridge failed to
 *   start before (whatever the networking: direct connections don't get through either); tasks
 *   are suggested instead
 */
export type TaskToolsRoute = 'direct' | 'bridge' | 'off';

/** The guard's variables for the chat's browser: Workbench's tools server, and (WSL2 with the bridge) the relay to it */
export const CHAT_BROWSER_URL_ENV = 'WORKBENCH_CHAT_BROWSER_URL';
export const CHAT_BROWSER_RELAY_ENV = 'WORKBENCH_CHAT_BROWSER_RELAY';

/** Set once the bridge failed to start, so later turns don't offer tools Claude can't reach */
let taskToolsBridgeFailed = false;

export function getTaskToolsRoute(): TaskToolsRoute {
  const wsl = getWslInfo();
  if (!wsl) return 'direct';
  if (getShellRuntimeStatus().wsl?.version === 1) return 'direct';
  if (taskToolsBridgeFailed) return 'off';
  // The bridge is a Windows program, which the distribution can only run with interop on
  if (wsl.interop === false) return wsl.networkingMode === 'mirrored' ? 'direct' : 'off';
  return 'bridge';
}

/** Claude Code's init message lists the bridge as failed: task tools are off from the next turn */
function noteBridgeFailure(event: ClaudeStreamMessage | Record<string, unknown>): void {
  const raw = event as { type?: unknown; subtype?: unknown; mcp_servers?: unknown };
  if (raw.type !== 'system' || raw.subtype !== 'init' || !Array.isArray(raw.mcp_servers)) return;
  const server = (raw.mcp_servers as Array<{ name?: string; status?: string }>).find((entry) => entry.name === TASK_TOOLS_SERVER_NAME);
  if (server?.status !== 'failed' || taskToolsBridgeFailed) return;
  taskToolsBridgeFailed = true;
  appLog.warn(`[Insights] The task tools bridge did not start in WSL (${getWslInfo()?.distro ?? 'unknown'}), is WSL interop off? Task tools are off for this session; tasks are suggested instead`);
}

/**
 * Forget a bridge failure (tests)
 * @internal
 */
export function resetTaskToolsBridgeForTests(): void {
  taskToolsBridgeFailed = false;
}

/**
 * The chat's Playwright server through the guard (playwright-guard.cjs, written to `tempDir`):
 * it runs in `<tempDir>/playwright`, which becomes its workspace root, so the files a tool call
 * names land there and never in the project, and its Node.js code tool is left out. Its own files
 * go there too, linked with absolute paths the chat can read (`dir`, given with --add-dir).
 * Natively Workbench's executable runs the guard as Node; in WSL the distribution's node does
 * (the server runs there)
 */
export async function guardChatPlaywright(
  servers: Record<string, McpServerEntry>,
  tempDir: string,
): Promise<{ servers: Record<string, McpServerEntry>; dir?: string }> {
  const entry = servers.playwright;
  if (entry?.type !== 'stdio' || !entry.args?.includes(PLAYWRIGHT_MCP_PACKAGE)) return { servers };
  const dir = join(tempDir, 'playwright');
  await mkdir(dir, { recursive: true });
  const script = join(tempDir, 'playwright-guard.cjs');
  await writeFile(script, PLAYWRIGHT_GUARD_SOURCE, 'utf-8');
  const server = [entry.command, ...entry.args, '--output-dir', toRuntimePath(dir), '--file-paths', 'absolute'];
  // The chat's browser is opened through Workbench's local tools server; inside WSL2 (NAT or
  // mirrored networking) the guard reaches it through the task tools bridge, a Windows process it
  // starts through interop (CHAT_BROWSER_RELAY_ENV: its executable and script)
  let env = entry.env;
  if (getWslInfo() && env?.[CHAT_BROWSER_URL_ENV] && getTaskToolsRoute() === 'bridge') {
    const relayScript = join(tempDir, 'task-tools-bridge.cjs');
    await writeFile(relayScript, TASK_TOOLS_BRIDGE_SOURCE, 'utf-8');
    env = { ...env, [CHAT_BROWSER_RELAY_ENV]: JSON.stringify({ command: toRuntimePath(process.execPath), script: relayScript }) };
  }
  const guarded: McpServerEntry = getWslInfo()
    ? { type: 'stdio', command: 'node', args: [toRuntimePath(script), toRuntimePath(dir), ...server], ...(env ? { env } : {}) }
    : { type: 'stdio', command: process.execPath, args: [script, dir, ...server], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  return { servers: { ...servers, playwright: guarded }, dir };
}

/** The task tools entry of the turn's MCP config (the bridge script is written to `tempDir`) */
export async function taskToolsEntry(
  taskTools: TaskToolsMcpServer,
  route: Exclude<TaskToolsRoute, 'off'>,
  tempDir: string,
): Promise<TaskToolsMcpServer | TaskToolsStdioServer> {
  if (route === 'direct') return taskTools;
  const bridgeScript = join(tempDir, 'task-tools-bridge.cjs');
  await writeFile(bridgeScript, TASK_TOOLS_BRIDGE_SOURCE, 'utf-8');
  // Claude Code starts the executable by its Linux path; the Windows process reads the script by its Windows path
  return toBridgeServer(taskTools, toRuntimePath(process.execPath), bridgeScript);
}

/**
 * Run an Insights turn through the Claude Code CLI.
 * Rejects with a readable message when the CLI fails, or an AbortError when cancelled.
 */
export async function runInsights(config: InsightsRunConfig, onStream?: InsightsStreamCallback): Promise<InsightsResult> {
  const { projectDir, message, history = [], abortSignal, attachments, graphify } = config;

  try {
    await whenShellRuntimeReady();
    const wsl = getWslInfo();
    let cliVersion: string | null | undefined;
    if (wsl) {
      // Claude Code runs inside WSL: the distribution's own claude (from the startup probe)
      if (!wsl.tools.claude.path) {
        throw new Error(formatInsightsError(INSIGHTS_ERROR_CODES.claudeCodeMissing, `Claude Code CLI not found in WSL (${wsl.distro})`));
      }
      cliVersion = wsl.tools.claude.version;
    } else {
      const cliInfo = await getToolInfoAsync('claude', { refreshIfMissing: true });
      if (!cliInfo.found) {
        throw new Error(formatInsightsError(INSIGHTS_ERROR_CODES.claudeCodeMissing, cliInfo.message || 'Claude Code CLI not found'));
      }
      cliVersion = cliInfo.version;
    }
    const taskToolsRoute = getTaskToolsRoute();
    const offeredTaskTools = taskToolsRoute === 'off' ? undefined : config.taskTools;
    // Messaging other running sessions (agent windows, tasks) with Claude Code's own tools
    const sessionMessaging = config.sessionMessages === true;
    // The Workbench tools hold the task tools unless told otherwise, and the messaging tools when
    // the chat has a name to send them under
    const kanban = !!offeredTaskTools && config.kanbanTools !== false;
    const chatName = offeredTaskTools ? config.chatName : undefined;

    // A resumed or forked session runs on the account that holds its transcript; when the
    // project's account is set to another one, or that account can't be used, a new session starts
    let plan: InsightsSessionPlan = config.session ?? { mode: 'new' };
    if (plan.mode !== 'new' && config.profileId && config.profileId !== plan.profileId) plan = { mode: 'new' };
    const { command, env, profileId } = await resolveClaudeEnv({ profileId: plan.mode === 'new' ? config.profileId : plan.profileId });
    if (plan.mode !== 'new' && profileId !== plan.profileId) plan = { mode: 'new' };
    if (graphify) {
      // graphify commands find the project's graph (GRAPHIFY_OUT, translated for WSL when the
      // run starts) and run without a full path (natively; in WSL from the login PATH)
      env.GRAPHIFY_OUT = dirname(graphify.graph);
      if (!wsl) env.PATH = [dirname(graphify.cli), env.PATH].filter(Boolean).join(getPathDelimiter());
    }

    const tempDir = await makeTempFolder(TEMP_FOLDER_PREFIXES.chatTurn);
    // The MCP servers go through a file, so the task tools' URL and token aren't in the process
    // list; the chat's own servers can't take the task tools' name. Tools and MCP servers are
    // given to every turn afresh: a resumed session has only what this turn passes
    let mcp: InsightsMcpArgs | undefined;
    const taskTools = offeredTaskTools && taskToolsRoute !== 'off'
      ? await taskToolsEntry(offeredTaskTools, taskToolsRoute, tempDir)
      : undefined;
    // Playwright works in the turn's own folder (its files, and the only folder it may write)
    const playwright = await guardChatPlaywright(Object.fromEntries(
      Object.entries(config.mcpServers ?? {}).filter(([name]) => name !== TASK_TOOLS_SERVER_NAME)
    ), tempDir);
    const chatServers = playwright.servers;
    // The browser drawer tells the turn's browser by its folder (the server's working folder,
    // which macOS reports by its real path: /private/var/...)
    const unregisterBrowserWorkspaces = playwright.dir
      ? [playwright.dir, await realpath(playwright.dir).catch(() => playwright.dir!)].map((dir) => registerChatBrowserWorkspace(dir, projectDir))
      : [];
    if (taskTools || Object.keys(chatServers).length > 0) {
      const configFile = join(tempDir, 'mcp-config.json');
      const mcpServers = { ...chatServers, ...(taskTools ? { [TASK_TOOLS_SERVER_NAME]: taskTools } : {}) };
      await writeFile(configFile, JSON.stringify({ mcpServers }), 'utf-8');
      mcp = {
        configFile,
        taskTools: !!taskTools,
        servers: Object.keys(chatServers),
        ...(playwright.dir ? { readDirs: [toRuntimePath(playwright.dir)] } : {}),
      };
      if (taskTools) env.MCP_TOOL_TIMEOUT = String(TASK_TOOL_TIMEOUT_MS);
      // Time for a connector's first start, when npx downloads it (unless the user set their own)
      if (mcp.servers.length > 0 && !env.MCP_TIMEOUT) env.MCP_TIMEOUT = String(MCP_STARTUP_TIMEOUT_MS);
    }

    // The system prompt describes exactly what the turn is given (through a file: no argument
    // length or shell quoting limits)
    const systemPromptFile = join(tempDir, 'system-prompt.md');
    const basePrompt = buildSystemPrompt({
      taskTools: kanban,
      chatName,
      cliTools: config.cliTools,
      graphify: !!graphify,
      mcpServers: Object.keys(chatServers),
      memory: config.memory,
      sessionMessaging,
      taskMessaging: kanban && config.taskMessaging === true,
      sharedBrowser: config.sharedBrowser,
      agentMode: !!config.agentMode,
    });
    const systemPrompt = graphify ? `${basePrompt}\n\n${graphify.commandPrompt}` : basePrompt;
    await writeFile(systemPromptFile, systemPrompt, 'utf-8');

    // One run of the turn: a session that is resumed or forked gets the new message only, a new
    // one the conversation so far folded into its prompt
    const attempt = async (turnPlan: InsightsSessionPlan) => {
      const state = createStreamState();
      const prompt = turnPlan.mode === 'new' ? buildConversationPrompt(message, history) : message;
      const handle = startClaudeProcess({
        command,
        args: buildInsightsArgs(
          toClaudeModel(config.model),
          toClaudeEffort(config.thinkingLevel),
          systemPromptFile,
          !!graphify,
          mcp,
          config.cliTools,
          config.memory,
          sessionArgs(turnPlan, randomUUID(), config.title),
          supportsSystemPromptSnapshot(cliVersion),
          sessionMessaging,
          config.agentMode,
        ),
        cwd: projectDir,
        env,
        // Document blocks (PDFs) are valid Anthropic content even though the shared type omits them
        input: buildMessageContent(prompt, attachments) as ClaudeUserContentBlock[],
        onMessage: (event) => {
          if (taskTools?.type === 'stdio') noteBridgeFailure(event);
          handleInsightsEvent(event, state, onStream);
        },
        abortSignal,
      });
      // A crash leaves the turn's folder to the next startup, which keeps it while this run goes on
      void noteTempFolderRun(tempDir, handle.child.pid);
      return { state, outcome: await handle.done };
    };

    let run: Awaited<ReturnType<typeof attempt>>;
    try {
      run = await attempt(plan);
      // The session couldn't be continued (its transcript is gone, or Claude Code refused to cut
      // it there): the turn runs again in a new session, which gets the conversation as text
      const nothingRan = !run.state.text && run.state.toolCalls.length === 0;
      const failed = run.outcome.exitCode !== 0 || run.state.result?.isError === true;
      if (plan.mode !== 'new' && nothingRan && failed && !run.outcome.aborted && !abortSignal?.aborted) {
        appLog.warn(`[Insights] Could not ${plan.mode} Claude Code session ${plan.sessionId}, starting a new one: ${run.state.result?.text ?? run.outcome.stderr.trim()}`);
        plan = { mode: 'new' };
        run = await attempt(plan);
      }
    } finally {
      for (const unregister of unregisterBrowserWorkspaces) unregister();
      await removeTempFolder(tempDir);
    }
    const { state, outcome } = run;

    if (outcome.aborted || abortSignal?.aborted) {
      const abortError = new Error('Insights request was cancelled');
      abortError.name = 'AbortError';
      throw abortError;
    }
    if (state.result?.isError) {
      throw new Error(state.result.text?.trim() || `Claude Code failed (${state.result.subtype ?? 'error'})`);
    }
    if (outcome.exitCode !== 0 && !state.result) {
      throw new Error(outcome.stderr.trim() || `Claude Code exited with code ${outcome.exitCode}`);
    }

    // A local slash command (`/compact`) has no assistant message: its output (or nothing) is the reply
    const slashCommand = message.trimStart().startsWith('/');
    const text = state.text.trim() ? state.text : (state.result?.text || state.localOutput || '');
    if (!text.trim() && !slashCommand) {
      throw new Error(EMPTY_RESPONSE_ERROR);
    }
    // Where the session is now: the reply's last assistant message, else (a local command) the
    // last message the turn wrote
    const cutAt = state.lastAssistantUuid ?? (slashCommand ? state.lastUuid : undefined);

    // Suggestion lines become cards: the reply keeps the rest
    return {
      text: stripTaskSuggestions(text),
      taskSuggestions: extractTaskSuggestions(text),
      toolCalls: state.toolCalls,
      claudeRef: state.sessionId && cutAt
        ? { sessionId: state.sessionId, messageUuid: cutAt, profileId }
        : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!(error instanceof Error && error.name === 'AbortError')) {
      onStream?.({ type: 'error', error: errorMsg });
    }
    throw error;
  }
}
