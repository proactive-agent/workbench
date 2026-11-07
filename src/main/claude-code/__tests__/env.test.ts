/**
 * The environment Claude Code runs with for an account:
 * - an account the app added runs on its own config dir, never on a shell API key
 * - a detected Claude Code setup on the default ~/.claude runs without CLAUDE_CONFIG_DIR (even
 *   when the app was started with one) and keeps the variables it may be configured with
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'os';
import path from 'path';

const profileEnvRef = vi.hoisted(() => ({ env: {} as Record<string, string>, detected: false }));

vi.mock('../../cli-utils', () => ({
  getClaudeCliInvocationAsync: async () => ({
    command: 'claude',
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-shell', CLAUDE_CONFIG_DIR: '/app/started/with' },
  }),
}));
vi.mock('../../cli-tool-manager', () => ({ getToolInfoAsync: async () => ({ found: false }) }));
const runtimeRef = vi.hoisted(() => ({ wsl: false, windows: false }));
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => runtimeRef.windows,
}));
vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  getWslInfo: () => (runtimeRef.wsl
    ? { distro: 'Ubuntu', home: '/home/me', loginPath: '/usr/bin', mountRoot: '/mnt/', tools: { claude: { path: '/home/me/.local/bin/claude', version: '2.1.0' } } }
    : null),
}));
vi.mock('../../services/profile', () => ({ getAPIProfileEnv: async () => ({}) }));
vi.mock('../../rate-limit-detector', () => ({
  getUsableProfileEnv: () => profileEnvRef.env,
  getRunnableProfileEnv: () => ({ env: profileEnvRef.env, profileId: 'p', profileName: 'P' }),
  isDetectedClaudeCodeProfile: () => profileEnvRef.detected,
}));

import { resolveClaudeEnv } from '../env';

beforeEach(() => {
  profileEnvRef.env = {};
  profileEnvRef.detected = false;
  runtimeRef.wsl = false;
  runtimeRef.windows = false;
});

describe('resolveClaudeEnv', () => {
  it("runs an added account on its config dir, without the shell's API key", async () => {
    profileEnvRef.env = { CLAUDE_CONFIG_DIR: '/profiles/work', CLAUDE_CODE_OAUTH_TOKEN: 'cached' };
    const { env } = await resolveClaudeEnv({ profileId: 'work' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/profiles/work');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("runs Claude Code's default dir without CLAUDE_CONFIG_DIR, keeping the setup's variables", async () => {
    profileEnvRef.env = { CLAUDE_CONFIG_DIR: path.join(homedir(), '.claude') };
    profileEnvRef.detected = true;
    const { env } = await resolveClaudeEnv({ profileId: 'claude-code' });
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-shell');
  });

  describe('in WSL', () => {
    beforeEach(() => {
      runtimeRef.windows = true;
      runtimeRef.wsl = true;
    });

    it("runs the distribution's claude with the app's environment, without Git Bash", async () => {
      profileEnvRef.env = { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-profiles\\work' };
      const previous = process.env.CLAUDE_CODE_GIT_BASH_PATH;
      process.env.CLAUDE_CODE_GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';
      try {
        const { command, env } = await resolveClaudeEnv({ profileId: 'work', extraEnv: { GRAPHIFY_OUT: 'C:\\p\\out' } });
        expect(command).toBe('/home/me/.local/bin/claude');
        // Not the Windows invocation's augmented PATH (runtime-exec never forwards PATH anyway)
        expect(env.PATH).not.toBe('/usr/bin');
        expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
        // Host paths: runtime-exec translates them when the run starts
        expect(env.CLAUDE_CONFIG_DIR).toBe('C:\\Users\\me\\.claude-profiles\\work');
        expect(env.GRAPHIFY_OUT).toBe('C:\\p\\out');
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
        else process.env.CLAUDE_CODE_GIT_BASH_PATH = previous;
      }
    });
  });
});
