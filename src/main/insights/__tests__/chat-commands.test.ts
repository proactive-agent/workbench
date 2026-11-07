/**
 * The chat's `/` menu asks Claude Code for its commands with the control protocol's initialize
 * request: only the answer to that request counts, and each command keeps its name, description
 * and argument hint.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../claude-code/env', () => ({ resolveClaudeEnv: vi.fn() }));
vi.mock('../../platform/runtime-exec', () => ({ spawnTool: vi.fn(), killRuntimeProcess: vi.fn() }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));

import { parseCommandsResponse } from '../chat-commands';

const response = (body: Record<string, unknown>) => JSON.stringify({ type: 'control_response', response: { request_id: 'workbench-commands', ...body } });

describe('parseCommandsResponse', () => {
  it('reads the commands of the initialize answer', () => {
    const line = response({
      subtype: 'success',
      response: {
        commands: [
          { name: 'graphify', description: 'Query the graph (user)', argumentHint: '' },
          { name: 'design', description: 'Grant access', argumentHint: 'consent | revoke', builtin: true },
          { description: 'nameless' },
        ],
      },
    });
    expect(parseCommandsResponse(line)).toEqual([
      { name: 'graphify', description: 'Query the graph (user)' },
      { name: 'design', description: 'Grant access', argumentHint: 'consent | revoke' },
    ]);
  });

  it('ignores other lines and other requests\' answers', () => {
    expect(parseCommandsResponse('{"type":"system","subtype":"init"}')).toBeNull();
    expect(parseCommandsResponse('not json')).toBeNull();
    expect(parseCommandsResponse(JSON.stringify({ type: 'control_response', response: { request_id: 'other', subtype: 'success' } }))).toBeNull();
  });

  it('fails with Claude Code\'s error', () => {
    expect(() => parseCommandsResponse(response({ subtype: 'error', error: 'not signed in' }))).toThrow('not signed in');
  });
});
