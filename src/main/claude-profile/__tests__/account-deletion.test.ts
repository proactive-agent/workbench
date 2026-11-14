/**
 * Deleting a detected Claude account: signed out with Claude Code's own logout, then its config
 * dir removed (or, for the default ~/.claude, only its sign-in settings); nothing removed when the
 * sign-out fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeProfile } from '../../../shared/types';

const homeRef = vi.hoisted(() => ({ dir: '' }));
const runTool = vi.hoisted(() => vi.fn());

vi.mock('../../platform/claude-home', () => ({
  getClaudeHome: () => homeRef.dir,
  isClaudeHomeInWsl: () => false,
}));
vi.mock('../../platform/runtime-exec', () => ({ runTool }));
vi.mock('../../cli-tool-manager', () => ({
  getToolInfoAsync: vi.fn(async () => ({ found: true, path: '/usr/bin/claude' })),
}));
vi.mock('../credential-utils', () => ({ clearKeychainCache: vi.fn() }));

import { deleteClaudeCodeAccountFiles } from '../account-deletion';

function account(configDir: string, detected: Partial<NonNullable<ClaudeProfile['detected']>>): ClaudeProfile {
  return {
    id: 'acc',
    name: 'Account',
    configDir,
    isDefault: false,
    createdAt: new Date(),
    detected: { provider: 'subscription', isDefaultDir: false, values: [], ...detected },
  } as ClaudeProfile;
}

beforeEach(() => {
  homeRef.dir = mkdtempSync(join(tmpdir(), 'account-deletion-'));
  runTool.mockReset();
  runTool.mockResolvedValue({ stdout: '', stderr: '' });
});

afterEach(() => {
  rmSync(homeRef.dir, { recursive: true, force: true });
});

describe('deleteClaudeCodeAccountFiles', () => {
  it('signs a sign-in out on its own config dir, then removes the dir', async () => {
    const dir = join(homeRef.dir, '.claude-2');
    mkdirSync(dir);
    writeFileSync(join(dir, '.credentials.json'), '{}');

    await deleteClaudeCodeAccountFiles(account(dir, { email: 'me@example.com' }));

    expect(runTool).toHaveBeenCalledWith('claude', ['auth', 'logout'], expect.objectContaining({
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: dir }),
    }));
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps everything when the sign-out fails', async () => {
    const dir = join(homeRef.dir, '.claude-2');
    mkdirSync(dir);
    runTool.mockRejectedValue(new Error('logout failed'));

    await expect(deleteClaudeCodeAccountFiles(account(dir, { email: 'me@example.com' }))).rejects.toThrow('logout failed');
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps the default ~/.claude, removing only how it reaches Claude from its settings', async () => {
    const dir = join(homeRef.dir, '.claude');
    mkdirSync(dir);
    const settings = {
      model: 'opus',
      apiKeyHelper: '/bin/key',
      permissions: { allow: ['Read'] },
      env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_MODEL: 'opus', FOO: '1' },
    };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));

    await deleteClaudeCodeAccountFiles(account(dir, { provider: 'auth-token', isDefaultDir: true }));

    // No sign-in to sign out
    expect(runTool).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'))).toEqual({
      model: 'opus',
      permissions: { allow: ['Read'] },
      env: { ANTHROPIC_MODEL: 'opus', FOO: '1' },
    });
  });

  it('signs the default dir out without CLAUDE_CONFIG_DIR', async () => {
    const dir = join(homeRef.dir, '.claude');
    mkdirSync(dir);

    await deleteClaudeCodeAccountFiles(account(dir, { isDefaultDir: true, email: 'me@example.com' }));

    const env = runTool.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });

  it('never removes the home dir or one above it', async () => {
    await expect(deleteClaudeCodeAccountFiles(account(homeRef.dir, {}))).rejects.toThrow(/Refusing/);
    expect(runTool).not.toHaveBeenCalled();
    expect(existsSync(homeRef.dir)).toBe(true);
  });
});
