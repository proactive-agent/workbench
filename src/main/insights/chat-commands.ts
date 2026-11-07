/**
 * The slash commands and skills Claude Code offers in a project, for the chat's `/` menu (with
 * the Clawd button on, a chat message may start with one).
 *
 * Asked the way the Agent SDK asks: a headless Claude Code with stream-json input gets the
 * control protocol's `initialize` request and answers with its commands (built-in ones that work
 * headless, the user's and the project's commands, skills and plugins'), each with a description
 * and argument hint. No message is sent, so the model isn't called; the process is stopped once
 * it answered.
 */
import type { ChatSlashCommand } from '../../shared/types';
import { resolveClaudeEnv } from '../claude-code/env';
import { killRuntimeProcess, spawnTool } from '../platform/runtime-exec';
import { appLog } from '../app-logger';

/** How long Claude Code may take to start and answer */
const PROBE_TIMEOUT_MS = 30_000;

const REQUEST_ID = 'workbench-commands';

/** The commands from a control response line, or null when the line is something else */
export function parseCommandsResponse(line: string): ChatSlashCommand[] | null {
  let message: { type?: unknown; response?: { request_id?: unknown; subtype?: unknown; error?: unknown; response?: { commands?: unknown } } };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return null;
  }
  if (message.type !== 'control_response' || message.response?.request_id !== REQUEST_ID) return null;
  if (message.response.subtype !== 'success') {
    throw new Error(typeof message.response.error === 'string' ? message.response.error : 'Claude Code did not list its commands');
  }
  const commands = Array.isArray(message.response.response?.commands) ? message.response.response.commands : [];
  return (commands as Array<{ name?: unknown; description?: unknown; argumentHint?: unknown }>)
    .filter((command) => typeof command.name === 'string' && command.name)
    .map((command) => ({
      name: command.name as string,
      description: typeof command.description === 'string' ? command.description : '',
      ...(typeof command.argumentHint === 'string' && command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    }));
}

/** Claude Code's slash commands and skills in `projectDir`, on the project's account */
export async function listChatCommands(projectDir: string, profileId?: string): Promise<ChatSlashCommand[]> {
  const { command, env } = await resolveClaudeEnv({ profileId });
  const child = spawnTool('claude', [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
  ], { command, cwd: projectDir, env, windowsHide: true, stdio: 'pipe' });

  return new Promise<ChatSlashCommand[]>((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (error: Error | null, commands?: ChatSlashCommand[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && !child.killed) killRuntimeProcess(child);
      if (error) reject(error);
      else resolve(commands ?? []);
    };
    const timer = setTimeout(() => finish(new Error('Claude Code did not list its commands in time')), PROBE_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        try {
          const commands = parseCommandsResponse(line);
          if (commands) finish(null, commands);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!settled) {
        appLog.warn(`[Insights] Claude Code exited (${code}) before listing its commands: ${stderr.trim()}`);
        finish(new Error(stderr.trim() || `Claude Code exited with code ${code}`));
      }
    });

    child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`);
  });
}
