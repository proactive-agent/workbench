/**
 * The slash commands and skills Claude Code offers in a project, for the chat's `/` menu (with
 * the Clawd button on, a chat message may start with one).
 *
 * Asked the way the Agent SDK asks: a headless Claude Code with stream-json input gets the
 * control protocol's `initialize` request and answers with its commands (built-in ones that work
 * headless, the user's and the project's commands, skills and plugins'), each with a description
 * and argument hint. No message is sent, so the model isn't called, and Claude Code exits once it
 * answered (its input ends after the request). It starts without MCP servers
 * (`--strict-mcp-config`): starting the user's servers only to read the list would launch them for
 * nothing; their prompts are left out of the menu.
 */
import type { ChatCommandsError, ChatSlashCommand } from '../../shared/types';
import { resolveClaudeEnv } from '../claude-code/env';
import { startClaudeProcess } from '../claude-code/process';
import { appLog } from '../app-logger';

/** How long Claude Code may take to start and answer */
const PROBE_TIMEOUT_MS = 30_000;

const REQUEST_ID = 'workbench-commands';

/** A failure to list the commands, with its code for the renderer (the details are logged) */
export class ChatCommandsListError extends Error {
  constructor(readonly code: ChatCommandsError, details?: string) {
    super(details || code);
  }
}

/**
 * Built-in commands that don't fit a chat, left out of the menu: `/clear` starts an empty session
 * behind the chat's history; the model, effort and output settings are the chat's own buttons;
 * the rest only work in Claude Code's interactive terminal or are internal
 */
const CHAT_HIDDEN_COMMANDS = new Set([
  'clear',
  'model',
  'effort',
  'fast',
  'output-style',
  'color',
  'config',
  'focus',
  'heapdump',
  'auto-mode-setup',
  'workflow-launch-exec',
]);

/** Whether a command belongs in the chat's menu (see CHAT_HIDDEN_COMMANDS; `__` names are internal) */
function isChatCommand(name: string): boolean {
  return !name.startsWith('__') && !CHAT_HIDDEN_COMMANDS.has(name);
}

/** The commands from a control response message, or null when the message is something else */
export function parseCommandsResponse(message: unknown): ChatSlashCommand[] | null {
  const raw = message as { type?: unknown; response?: { request_id?: unknown; subtype?: unknown; error?: unknown; response?: { commands?: unknown } } };
  if (raw?.type !== 'control_response' || raw.response?.request_id !== REQUEST_ID) return null;
  if (raw.response.subtype !== 'success') {
    throw new ChatCommandsListError('notListed', typeof raw.response.error === 'string' ? raw.response.error : undefined);
  }
  const commands = raw.response.response?.commands;
  // A Claude Code that answers without a command list can't fill the menu
  if (!Array.isArray(commands)) throw new ChatCommandsListError('notListed');
  const seen = new Set<string>();
  return (commands as Array<{ name?: unknown; description?: unknown; argumentHint?: unknown }>)
    .filter((command): command is { name: string } & typeof command => typeof command.name === 'string' && !!command.name)
    .filter((command) => isChatCommand(command.name) && !seen.has(command.name) && !!seen.add(command.name))
    .map((command) => ({
      name: command.name,
      description: typeof command.description === 'string' ? command.description : '',
      ...(typeof command.argumentHint === 'string' && command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    }));
}

/** Claude Code's slash commands and skills in `projectDir`, on the project's account */
export async function listChatCommands(projectDir: string, profileId?: string): Promise<ChatSlashCommand[]> {
  const { command, env } = await resolveClaudeEnv({ profileId });
  let commands: ChatSlashCommand[] | null = null;
  let parseError: unknown;
  const handle = startClaudeProcess({
    command,
    args: [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--strict-mcp-config',
    ],
    cwd: projectDir,
    env,
    // The request, then the end of input: Claude Code answers and exits
    input: `${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`,
    onMessage: (message) => {
      if (commands || parseError) return;
      try {
        commands = parseCommandsResponse(message);
      } catch (error) {
        parseError = error;
      }
      // Nothing else is needed from it
      if (commands || parseError) handle.stop();
    },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const outcome = await handle.done;
  if (parseError) throw parseError;
  if (commands) return commands;
  if (outcome.timedOut) throw new ChatCommandsListError('timeout');
  const details = outcome.stderr.trim() || `exit code ${outcome.exitCode}`;
  appLog.warn(`[Insights] Claude Code did not list its commands: ${details}`);
  throw new ChatCommandsListError('failed', details);
}
