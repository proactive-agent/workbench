/**
 * The chat's `/` menu asks Claude Code for its commands with the control protocol's initialize
 * request: only the answer to that request counts, commands that don't fit a chat are left out,
 * and a failure comes back as a code the renderer words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const startClaudeProcess = vi.hoisted(() => vi.fn());
vi.mock('../../claude-code/env', () => ({ resolveClaudeEnv: vi.fn(async () => ({ command: 'claude', env: {} })) }));
vi.mock('../../claude-code/process', () => ({ startClaudeProcess }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));

import { ChatCommandsListError, listChatCommands, parseCommandsResponse } from '../chat-commands';

const response = (body: Record<string, unknown>) => ({ type: 'control_response', response: { request_id: 'workbench-commands', ...body } });

/** A fake Claude Code that sends `messages`, then ends with `outcome` */
function fakeRun(messages: unknown[], outcome: Record<string, unknown> = {}) {
  startClaudeProcess.mockImplementation((options: { onMessage: (message: unknown) => void }) => {
    const stop = vi.fn();
    const done = Promise.resolve().then(() => {
      for (const message of messages) options.onMessage(message);
      return { exitCode: 0, stderr: '', timedOut: false, ...outcome };
    });
    return { done, stop };
  });
}

beforeEach(() => {
  startClaudeProcess.mockReset();
});

describe('parseCommandsResponse', () => {
  it('reads the commands of the initialize answer, leaving out the ones that don\'t fit a chat', () => {
    const commands = parseCommandsResponse(response({
      subtype: 'success',
      response: {
        commands: [
          { name: 'graphify', description: 'Query the graph (user)', argumentHint: '' },
          { name: 'design', description: 'Grant access', argumentHint: 'consent | revoke', builtin: true },
          { name: 'clear', description: 'Clear the conversation' },
          { name: '__remote-workflow', description: 'internal' },
          { name: 'compact', description: 'Compact' },
          { name: 'graphify', description: 'duplicate' },
          { description: 'nameless' },
        ],
      },
    }));
    expect(commands).toEqual([
      { name: 'graphify', description: 'Query the graph (user)' },
      { name: 'design', description: 'Grant access', argumentHint: 'consent | revoke' },
      { name: 'compact', description: 'Compact' },
    ]);
  });

  it('ignores other messages and other requests\' answers', () => {
    expect(parseCommandsResponse({ type: 'system', subtype: 'init' })).toBeNull();
    expect(parseCommandsResponse({ type: 'control_response', response: { request_id: 'other', subtype: 'success' } })).toBeNull();
  });

  it('fails when Claude Code refuses or answers without a list', () => {
    expect(() => parseCommandsResponse(response({ subtype: 'error', error: 'not signed in' }))).toThrow(ChatCommandsListError);
    expect(() => parseCommandsResponse(response({ subtype: 'success', response: {} }))).toThrow(ChatCommandsListError);
  });
});

describe('listChatCommands', () => {
  it('asks with initialize, without MCP servers or a saved session, and returns the list', async () => {
    fakeRun([{ type: 'system' }, response({ subtype: 'success', response: { commands: [{ name: 'review', description: 'Review' }] } })]);
    await expect(listChatCommands('/project')).resolves.toEqual([{ name: 'review', description: 'Review' }]);
    const options = startClaudeProcess.mock.calls[0][0] as { args: string[]; input: string; cwd: string };
    expect(options.cwd).toBe('/project');
    expect(options.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--no-session-persistence', '--input-format', 'stream-json']));
    expect(JSON.parse(options.input)).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
  });

  it('fails with a code: timeout, or failed when Claude Code exits without answering', async () => {
    fakeRun([], { timedOut: true, exitCode: null });
    await expect(listChatCommands('/project')).rejects.toMatchObject({ code: 'timeout' });
    fakeRun([], { exitCode: 1, stderr: 'error: unknown option' });
    await expect(listChatCommands('/project')).rejects.toMatchObject({ code: 'failed' });
  });
});
