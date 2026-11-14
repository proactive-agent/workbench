import { writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as pty from '@lydell/node-pty';
import type { TerminalProcess } from '../types';
import { buildCdCommand, escapeShellArg } from '../../../shared/utils/shell-escape';

// Mock the platform module (main/platform/index.ts)
vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => false),
  isLinux: vi.fn(() => false),
  isUnix: vi.fn(() => false),
  getCurrentOS: vi.fn(() => 'linux'),
}));

import { isWindows } from '../../platform';

/** Escape special regex characters in a string for safe use in RegExp constructor */
const escapeForRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mockGetClaudeCliInvocation = vi.fn();
const mockGetClaudeCliInvocationAsync = vi.fn();
const mockGetClaudeProfileManager = vi.fn();
const mockInitializeClaudeProfileManager = vi.fn();
const mockPersistSession = vi.fn();

const createMockDisposable = (): pty.IDisposable => ({ dispose: vi.fn() });

const createMockPty = (): pty.IPty => ({
  pid: 123,
  cols: 80,
  rows: 24,
  process: 'bash',
  handleFlowControl: false,
  onData: vi.fn(() => createMockDisposable()),
  onExit: vi.fn(() => createMockDisposable()),
  write: vi.fn(),
  resize: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  kill: vi.fn(),
  clear: vi.fn(),
});

const createMockTerminal = (overrides: Partial<TerminalProcess> = {}): TerminalProcess => ({
  id: 'term-1',
  pty: createMockPty(),
  outputBuffer: '',
  isCLIMode: false,
  claudeProfileId: undefined,
  title: 'Terminal 1',  // Use default terminal name pattern to match production behavior
  cwd: '/tmp/project',
  projectPath: '/tmp/project',
  ...overrides,
});

vi.mock('../../cli-utils', () => ({
  getClaudeCliInvocation: mockGetClaudeCliInvocation,
  getClaudeCliInvocationAsync: mockGetClaudeCliInvocationAsync,
}));

vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: mockGetClaudeProfileManager,
  initializeClaudeProfileManager: mockInitializeClaudeProfileManager,
}));

// The account saved for the window's project (none unless a test sets one)
const mockProjectAccount = vi.hoisted(() => vi.fn((): unknown => undefined));
vi.mock('../../project-account', () => ({ projectAccount: mockProjectAccount }));

// Which transcript files exist: a restored window asks for the exact path its session has under
// each account, and nothing in a test writes those files. Hoisted, because the mock of `fs` is
// built while this file's own `import 'fs'` is resolved, before its variables exist
const mockStat = vi.hoisted(() => vi.fn(async (_file: string): Promise<{ isFile: () => boolean }> => {
  throw new Error('ENOENT');
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    promises: {
      writeFile: vi.fn(),
      stat: mockStat,
    },
  };
});

vi.mock('../session-handler', () => ({
  persistSession: mockPersistSession,
  persistSessionAsync: mockPersistSession,
}));

// Mock the store of the sessions agent windows start, so tests write nothing to disk
const mockRecordAgentSession = vi.fn();
const mockLastAgentSession: ReturnType<typeof vi.fn> = vi.fn(async () => undefined);
const mockReadAgentSessions: ReturnType<typeof vi.fn> = vi.fn(async () => []);
vi.mock('../../agent-session-store', () => ({
  recordAgentSessionAsync: mockRecordAgentSession,
  lastAgentSession: mockLastAgentSession,
  readAgentSessions: mockReadAgentSessions,
}));

// Mock the transcript lookups a restored window uses: its own session, and the directory's latest
const mockFindSessionTranscript: ReturnType<typeof vi.fn> = vi.fn(async () => null);
const mockLatestTranscript: ReturnType<typeof vi.fn> = vi.fn(async () => null);
vi.mock('../../claude-code/session-spending', () => ({
  findSessionTranscript: mockFindSessionTranscript,
  latestTranscript: mockLatestTranscript,
}));
// Every account's config dir: Claude Code's default dir (the real home's, so the code under test
// recognises it as the default), two accounts of the app's own, and whichever the caller knows of.
// The default dir comes first because that is where `claudeConfigDirs` itself puts it, which is
// what makes the order a window's own account has to be lifted out of worth testing against
vi.mock('../../claude-profile/profile-config-dirs', async () => {
  const { homedir } = await import('os');
  const { default: nodePath } = await import('path');
  return {
    claudeConfigDirs: (extra: Array<string | undefined> = []) => {
      const dirs = [nodePath.join(homedir(), '.claude'), '/home/user/.claude', '/home/user/.claude-profiles/work'];
      // Resolved and deduplicated exactly as the real `claudeConfigDirs` returns them, so a caller
      // that resolves the dir it hands in finds it among these on every host
      return [...new Set([...dirs, ...extra].filter((dir): dir is string => !!dir).map((dir) => nodePath.resolve(dir)))];
    },
  };
});

/**
 * The accounts the mock above lists, in the spelling the handler passes on: `claudeConfigDirs` and
 * `resolveSessionConfigDir` both resolve a config dir, which on a Windows host turns a POSIX
 * literal into a drive-letter path. Resolving the fixtures too keeps every assertion about the
 * command, and every path built from them, true on all three hosts.
 */
const OTHER_ACCOUNT_DIR = path.resolve('/home/user/.claude');
const WORK_ACCOUNT_DIR = path.resolve('/home/user/.claude-profiles/work');
/** The config dir of a profile a test hands to the handler itself */
const PROFILE_CONFIG_DIR = path.resolve('/tmp/claude-config');

// Mock PtyManager.writeToPty - the implementation now uses this instead of terminal.pty.write
const mockWriteToPty = vi.fn();
// The window's Workbench messaging tools: a config file, when a test sets one
const mockWindowToolsConfig = vi.hoisted(() => vi.fn(async (): Promise<string | undefined> => undefined));
vi.mock('../../session-messaging/window-tools', () => ({
  windowToolsConfig: mockWindowToolsConfig,
  windowSettingsFile: (file: string) => `${file.slice(0, file.lastIndexOf('/'))}/settings.json`,
}));

vi.mock('../pty-manager', () => ({
  writeToPty: mockWriteToPty,
}));

// Mock settings-utils so invokeCLIAsync defaults to claude-code in tests
vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: vi.fn(async () => undefined),
  readSettingsFile: vi.fn(() => undefined),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    tmpdir: vi.fn(() => '/tmp'),
  };
});

/**
 * Helper to set the current platform for testing
 */
function mockPlatform(platform: 'win32' | 'darwin' | 'linux') {
  const mockIsWindows = vi.mocked(isWindows);
  mockIsWindows.mockReturnValue(platform === 'win32');
}

/** PowerShell single-quoted literal, as the code under test writes it */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The shell agent windows run on each platform: PowerShell on Windows, POSIX elsewhere */
function platformShellKind(platform: 'win32' | 'darwin' | 'linux'): 'powershell' | 'posix' {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * Helper to get platform-specific expectations for PATH prefix
 */
function getPathPrefixExpectation(
  platform: 'win32' | 'darwin' | 'linux',
  pathValue: string,
  command: string
): string {
  // Absolute executable commands no longer need PATH prefix injection.
  if (path.isAbsolute(command)) {
    return '';
  }

  if (platform === 'win32') {
    // PowerShell: $env:PATH = 'value';
    return `$env:PATH = ${psQuote(pathValue)}; `;
  }
  // Unix/macOS: PATH='value' '
  return `PATH='${pathValue}' `;
}

function expectPathPrefix(
  written: string,
  platform: 'win32' | 'darwin' | 'linux',
  pathValue: string,
  command: string
): void {
  const expectedPrefix = getPathPrefixExpectation(platform, pathValue, command);
  if (expectedPrefix) {
    expect(written).toContain(expectedPrefix);
  } else {
    expect(written).not.toContain('PATH=');
    expect(written).not.toContain('$env:PATH');
  }
}

/**
 * Helper to get platform-specific expectations for command quoting
 */
function getQuotedCommand(platform: 'win32' | 'darwin' | 'linux', command: string): string {
  if (platform === 'win32') {
    // PowerShell: the call operator on a single-quoted path
    return `& ${psQuote(command)}`;
  }
  // Unix/macOS: use escapeShellArg which properly handles embedded single quotes
  return escapeShellArg(command);
}

/**
 * Helper to get platform-specific clear command, with the separator that follows it
 */
function getClearPrefix(platform: 'win32' | 'darwin' | 'linux'): string {
  return platform === 'win32' ? 'Clear-Host; ' : 'clear && ';
}

/**
 * Helper to get platform-specific history prefix
 */
function getHistoryPrefix(platform: 'win32' | 'darwin' | 'linux'): string {
  return platform === 'win32' ? '' : 'HISTFILE= HISTCONTROL=ignorespace ';
}

/**
 * Helper to get platform-specific temp file extension (PowerShell reads a plain token file)
 */
function getTempFileExtension(_platform: 'win32' | 'darwin' | 'linux'): string {
  return '';
}

/**
 * Helper to get platform-specific token file content
 */
function getTokenFileContent(platform: 'win32' | 'darwin' | 'linux', token: string): string {
  if (platform === 'win32') {
    return token;
  }
  return `export CLAUDE_CODE_OAUTH_TOKEN='${token}'\n`;
}

/**
 * Helper to get platform-specific temp file invocation
 */
function getTempFileInvocation(platform: 'win32' | 'darwin' | 'linux', tokenPath: string): string {
  if (platform === 'win32') {
    return `$env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content -LiteralPath ${psQuote(tokenPath)} -Raw -ErrorAction Stop).Trim(); `;
  }
  return `source '${tokenPath}'`;
}

/**
 * Helper to get platform-specific temp file cleanup
 *
 * Note: Windows deletes BEFORE the command runs, for security - environment
 * variables persist in memory after deletion.
 */
function getTempFileCleanup(platform: 'win32' | 'darwin' | 'linux', tokenPath: string): string {
  if (platform === 'win32') {
    return `Remove-Item -LiteralPath ${psQuote(tokenPath)} -Force -ErrorAction SilentlyContinue; `;
  }
  return `&& rm -f '${tokenPath}' &&`;
}

/**
 * Helper to get platform-specific exec command
 */
function getExecCommand(platform: 'win32' | 'darwin' | 'linux', command: string): string {
  if (platform === 'win32') {
    return command; // Windows doesn't use exec
  }
  return `exec ${command}`;
}

/**
 * Helper to get platform-specific config dir command
 */
function getConfigDirCommand(platform: 'win32' | 'darwin' | 'linux', configDir: string): string {
  if (platform === 'win32') {
    return `$env:CLAUDE_CONFIG_DIR = ${psQuote(configDir)}; `;
  }
  return `CLAUDE_CONFIG_DIR='${configDir}'`;
}

/** The platform's way of running the command with CLAUDE_CONFIG_DIR taken out of the environment */
function getUnsetConfigDirCommand(platform: 'win32' | 'darwin' | 'linux'): string {
  if (platform === 'win32') {
    return 'Remove-Item Env:\\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; ';
  }
  return 'env -u CLAUDE_CONFIG_DIR ';
}

describe('cli-integration-handler', () => {
  beforeEach(() => {
    mockGetClaudeCliInvocation.mockClear();
    mockGetClaudeProfileManager.mockClear();
    mockPersistSession.mockClear();
    mockWriteToPty.mockClear();
    vi.mocked(writeFileSync).mockClear();
  });

  describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
    beforeEach(() => {
      mockPlatform(platform);
    });

    it('uses the resolved CLI path and PATH prefix when invoking Claude', async () => {
      mockGetClaudeCliInvocation.mockReturnValue({
        command: "/opt/claude bin/claude's",
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', undefined, () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(buildCdCommand('/tmp/project', platformShellKind(platform)));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', "/opt/claude bin/claude's");
      expect(written).toContain(getQuotedCommand(platform, "/opt/claude bin/claude's"));
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
      expect(profileManager.getActiveProfile).toHaveBeenCalled();
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('default');
    });

    it('uses the temp token flow when the active profile has an oauth token', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-1',
          name: 'Work',
          isDefault: false,
          oauthToken: 'token-value',
        })),
        getProfileToken: vi.fn(() => 'token-value'),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234);

      const terminal = createMockTerminal({ id: 'term-3' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'prof-1', () => null);

      const tokenPath = vi.mocked(writeFileSync).mock.calls[0]?.[0] as string;
      const tokenContents = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
      const tokenPrefix = path.join(tmpdir(), '.claude-token-1234-');
      const tokenExt = getTempFileExtension(platform);
      expect(tokenPath).toMatch(new RegExp(`^${escapeForRegex(tokenPrefix)}[0-9a-f]{16}${escapeForRegex(tokenExt)}$`));
      expect(tokenContents).toBe(getTokenFileContent(platform, 'token-value'));

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const clearCmd = getClearPrefix(platform);
      const histPrefix = getHistoryPrefix(platform);

      expect(written).toContain(histPrefix);
      expect(written).toContain(clearCmd);
      // Inside bash -c "..." a backslash (a Windows host's temp path) is escaped
      const shownPath = platform === 'win32' ? tokenPath : tokenPath.replace(/\\/g, '\\\\');
      expect(written).toContain(getTempFileInvocation(platform, shownPath));
      expect(written).toContain(getTempFileCleanup(platform, shownPath));
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-1');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);

      nowSpy.mockRestore();
    });

    it('prefers the config dir flow when profile has both oauth token and config dir', async () => {
      // The configDir method is preferred over temp-file because CLAUDE_CONFIG_DIR lets
      // Claude Code read full Keychain credentials including subscriptionType ("max") and
      // rateLimitTier. Using CLAUDE_CODE_OAUTH_TOKEN alone lacks tier info.
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-both',
          name: 'Work',
          isDefault: false,
          oauthToken: 'token-value',
          configDir: PROFILE_CONFIG_DIR,
        })),
        getProfileToken: vi.fn(() => 'token-value'),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-both' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'prof-both', () => null);

      // Should NOT write a temp file - configDir is used instead
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const clearCmd = getClearPrefix(platform);
      const histPrefix = getHistoryPrefix(platform);
      const configDir = getConfigDirCommand(platform, PROFILE_CONFIG_DIR);

      expect(written).toContain(histPrefix);
      expect(written).toContain(configDir);
      expect(written).toContain(clearCmd);
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-both');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-both');
    });

    /**
     * Claude Code's own setups are listed as accounts, and one of them is the default `~/.claude`
     * while still not being the default profile. Naming that dir in CLAUDE_CONFIG_DIR makes Claude
     * Code read `~/.claude/.claude.json` instead of `~/.claude.json`, so the window loses the
     * sign-in: the variable has to be absent, not set to it.
     */
    it('takes CLAUDE_CONFIG_DIR out of the environment for a detected account on the default dir', async () => {
      const command = '/opt/claude/bin/claude';
      const defaultDir = path.join(homedir(), '.claude');
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-detected',
          name: 'Claude Code',
          isDefault: false,
          detected: true,
          configDir: defaultDir,
        })),
        getProfileToken: vi.fn(() => undefined),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({ command, env: { PATH: '/opt/claude/bin:/usr/bin' } });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-detected' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'prof-detected', () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getUnsetConfigDirCommand(platform));
      // Never set to the default dir, and never falls back to writing a token temp file
      expect(written).not.toContain(getConfigDirCommand(platform, defaultDir));
      expect(written).not.toMatch(/CLAUDE_CONFIG_DIR\s*=\s*[^"\s]/);
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-detected');
    });

    it('handles missing profiles by falling back to the default command', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => undefined),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-6' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'missing', () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(profileManager.getProfile).toHaveBeenCalledWith('missing');
      expect(profileManager.markProfileUsed).not.toHaveBeenCalled();
    });

    it('uses the config dir flow when the active profile has a config dir', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-2',
          name: 'Work',
          isDefault: false,
          configDir: PROFILE_CONFIG_DIR,
        })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-4' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'prof-2', () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const clearCmd = getClearPrefix(platform);
      const histPrefix = getHistoryPrefix(platform);
      const configDir = getConfigDirCommand(platform, PROFILE_CONFIG_DIR);

      expect(written).toContain(histPrefix);
      expect(written).toContain(configDir);
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', command);
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(written).toContain(clearCmd);
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-2');
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-2');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('uses profile switching when a non-default profile is requested', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-3',
          name: 'Team',
          isDefault: false,
        })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-5' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'prof-3', () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getQuotedCommand(platform, command));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', command);
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-3');
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-3');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('changes to the project directory and continues its latest session', async () => {
      mockGetClaudeCliInvocation.mockReturnValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });

      const terminal = createMockTerminal({
        id: 'term-2',
        cwd: undefined,
        projectPath: '/tmp/project',
      });

      const { resumeClaude } = await import('../cli-integration-handler');

      resumeClaude(terminal, () => null);

      const resumeCall = mockWriteToPty.mock.calls[0][1] as string;
      expectPathPrefix(resumeCall, platform, '/opt/claude/bin:/usr/bin', '/opt/claude/bin/claude');
      expect(resumeCall).toContain(getQuotedCommand(platform, '/opt/claude/bin/claude') + ' --continue');
      expect(resumeCall).not.toContain('--resume');
      expect(resumeCall).toContain('/tmp/project');
      expect(resumeCall.indexOf('/tmp/project')).toBeLessThan(resumeCall.indexOf(' --continue'));
      expect(terminal.isCLIMode).toBe(true);
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);

      mockWriteToPty.mockClear();
      mockPersistSession.mockClear();
      terminal.projectPath = undefined;
      terminal.isCLIMode = false;
      resumeClaude(terminal, () => null);
      const continueCall = mockWriteToPty.mock.calls[0][1] as string;
      expect(continueCall).toContain(getQuotedCommand(platform, '/opt/claude/bin/claude') + ' --continue');
      expect(terminal.isCLIMode).toBe(true);
      expect(mockPersistSession).not.toHaveBeenCalled();
    });
  });

  it('throws when invokeClaude cannot resolve the CLI invocation', async () => {
    mockGetClaudeCliInvocation.mockImplementation(() => {
      throw new Error('boom');
    });
    const profileManager = {
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);

    const terminal = createMockTerminal({ id: 'term-err' });

    const { invokeClaude } = await import('../cli-integration-handler');
    expect(() => invokeClaude(terminal, '/tmp/project', undefined, () => null)).toThrow('boom');
    expect(mockWriteToPty).not.toHaveBeenCalled();
  });

  it('throws when resumeClaude cannot resolve the CLI invocation', async () => {
    mockGetClaudeCliInvocation.mockImplementation(() => {
      throw new Error('boom');
    });

    const terminal = createMockTerminal({
      id: 'term-err-2',
      cwd: undefined,
      projectPath: '/tmp/project',
    });

    const { resumeClaude } = await import('../cli-integration-handler');
    expect(() => resumeClaude(terminal, () => null)).toThrow('boom');
    expect(mockWriteToPty).not.toHaveBeenCalled();
  });

  it('throws when writing the OAuth token temp file fails', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({
      command: '/opt/claude/bin/claude',
      env: { PATH: '/opt/claude/bin:/usr/bin' },
    });
    const profileManager = {
      getActiveProfile: vi.fn(),
      getProfile: vi.fn(() => ({
        id: 'prof-err',
        name: 'Work',
        isDefault: false,
        oauthToken: 'token-value',
      })),
      getProfileToken: vi.fn(() => 'token-value'),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const terminal = createMockTerminal({ id: 'term-err-3' });

    const { invokeClaude } = await import('../cli-integration-handler');
    expect(() => invokeClaude(terminal, '/tmp/project', 'prof-err', () => null)).toThrow('disk full');
    expect(mockWriteToPty).not.toHaveBeenCalled();
  });

  it('includes YOLO mode flag when dangerouslySkipPermissions is true', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({
      command: '/opt/claude/bin/claude',
      env: { PATH: '/opt/claude/bin:/usr/bin' },
    });
    const profileManager = {
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);

    const terminal = createMockTerminal();

    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(terminal, '/tmp/project', undefined, () => null, true);

    const written = mockWriteToPty.mock.calls[0][1] as string;
    expect(written).toContain('--dangerously-skip-permissions');
    expect(terminal.dangerouslySkipPermissions).toBe(true);
  });

  it('does not include YOLO mode flag when dangerouslySkipPermissions is false', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({
      command: '/opt/claude/bin/claude',
      env: { PATH: '/opt/claude/bin:/usr/bin' },
    });
    const profileManager = {
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);

    const terminal = createMockTerminal();

    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(terminal, '/tmp/project', undefined, () => null, false);

    const written = mockWriteToPty.mock.calls[0][1] as string;
    expect(written).not.toContain('--dangerously-skip-permissions');
    expect(terminal.dangerouslySkipPermissions).toBe(false);
  });

  it('resets terminal state on error', async () => {
    mockGetClaudeCliInvocation.mockImplementation(() => {
      throw new Error('CLI error');
    });
    const profileManager = {
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);

    const terminal = createMockTerminal({
      isCLIMode: false,
      claudeProfileId: 'old-profile',
    });

    const { invokeClaude } = await import('../cli-integration-handler');
    expect(() => invokeClaude(terminal, '/tmp/project', 'new-profile', () => null)).toThrow('CLI error');

    // Terminal state should be rolled back
    expect(terminal.isCLIMode).toBe(false);
    expect(terminal.claudeProfileId).toBe('old-profile');
  });
});

/**
 * Tests for invokeCLIAsync() - async version with timeout protection
 */
describe('invokeCLIAsync', () => {
  beforeEach(() => {
    mockGetClaudeCliInvocationAsync.mockClear();
    mockInitializeClaudeProfileManager.mockClear();
    mockPersistSession.mockClear();
    mockWriteToPty.mockClear();
    vi.mocked(writeFileSync).mockClear();
  });

  describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
    beforeEach(() => {
      mockPlatform(platform);
    });

    it('should invoke Claude asynchronously with default profile', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(buildCdCommand('/tmp/project', platformShellKind(platform)));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', '/opt/claude/bin/claude');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('default');
    });

    it('starts on the account saved for the window\'s project when none is given', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);
      mockProjectAccount.mockReturnValueOnce({ id: 'prof-config', name: 'Work', isDefault: false, configDir: PROFILE_CONFIG_DIR });

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null);

      expect(mockProjectAccount).toHaveBeenCalledWith(profileManager, '/tmp/project');
      expect(terminal.claudeProfileId).toBe('prof-config');
      expect(mockWriteToPty.mock.calls[0][1] as string).toContain(getConfigDirCommand(platform, PROFILE_CONFIG_DIR));
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-config');
    });

    it('should handle profile with configDir', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-config',
          name: 'Work',
          isDefault: false,
          configDir: PROFILE_CONFIG_DIR,
        })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', 'prof-config', () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const clearCmd = getClearPrefix(platform);
      const histPrefix = getHistoryPrefix(platform);
      const configDir = getConfigDirCommand(platform, PROFILE_CONFIG_DIR);

      expect(written).toContain(histPrefix);
      expect(written).toContain(configDir);
      expect(written).toContain(clearCmd);
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-config');
    });

    it('should timeout after 10 seconds if CLI invocation hangs', async () => {
      mockGetClaudeCliInvocationAsync.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({
          command: '/opt/claude/bin/claude',
          env: { PATH: '/opt/claude/bin:/usr/bin' },
        }), 15000))
      );
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');

      await expect(invokeCLIAsync(terminal, '/tmp/project', undefined, () => null))
        .rejects.toThrow('CLI invocation timeout after 10s');

      // Terminal state should be rolled back
      expect(terminal.isCLIMode).toBe(false);
    }, 12000); // Allow 12 seconds for test (10s timeout + 2s buffer)

    it('should reset terminal state on async error', async () => {
      mockGetClaudeCliInvocationAsync.mockRejectedValue(new Error('Async CLI error'));
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal({
        isCLIMode: false,
        claudeProfileId: 'old-profile',
      });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await expect(invokeCLIAsync(terminal, '/tmp/project', 'new-profile', () => null))
        .rejects.toThrow('Async CLI error');

      // Terminal state should be rolled back
      expect(terminal.isCLIMode).toBe(false);
      expect(terminal.claudeProfileId).toBe('old-profile');
    });

    it('should include YOLO mode flag when dangerouslySkipPermissions is true', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, true);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain('--dangerously-skip-permissions');
      expect(terminal.dangerouslySkipPermissions).toBe(true);
    });

    it('resumes a task session in its worktree on the config dir that holds the transcript', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({ id: 'work', name: 'Work', isDefault: true, configDir: '/tmp/work-config' })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      // The terminal already runs on that profile: the config dir is still set explicitly
      const terminal = createMockTerminal({ claudeProfileId: 'work' });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project/.workbench/worktrees/tasks/001-x', 'work', () => null, true, {
        resumeSessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
        configDir: '/tmp/task-config',
      });

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(buildCdCommand('/tmp/project/.workbench/worktrees/tasks/001-x', platformShellKind(platform)));
      // The config dir is resolved on the host (a drive letter on Windows)
      expect(written).toContain(getConfigDirCommand(platform, path.resolve('/tmp/task-config')));
      expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455 --dangerously-skip-permissions');
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('work');
      expect(terminal.isCLIMode).toBe(true);
    });

    it('falls back to the profile config dir when the run has none', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({ id: 'work', name: 'Work', isDefault: false, configDir: '/tmp/work-config' })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/wt', 'work', () => null, false, { resumeSessionId: 'sess-1' });

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getConfigDirCommand(platform, path.resolve('/tmp/work-config')));
      expect(written).toContain('--resume sess-1');
      expect(written).not.toContain('--dangerously-skip-permissions');
    });

    it("takes the window's CLAUDE_CONFIG_DIR away for a run in the default config dir", async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(),
        // The account the window was spawned on: its config dir is in the window's environment
        getProfile: vi.fn(() => ({ id: 'work', name: 'Work', isDefault: false, configDir: '/tmp/work-config' })),
        getProfileToken: vi.fn(() => 'tok-123'),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/wt', 'work', () => null, false, {
        resumeSessionId: 'sess-1',
        configDir: path.join(homedir(), '.claude'),
      });

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const unset = platform === 'win32'
        ? 'Remove-Item Env:\\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; '
        : 'env -u CLAUDE_CONFIG_DIR ';
      expect(written).toContain(unset);
      expect(written).toContain('--resume sess-1');
      // Neither the work account's dir nor the default one is set: the run belongs to ~/.claude,
      // which Claude Code reads only while the variable is absent
      expect(written).not.toContain('/tmp/work-config');
      expect(written).not.toContain(getConfigDirCommand(platform, path.join(homedir(), '.claude')));
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('work');
    });

    it('refuses a session id that is not a plain id', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockInitializeClaudeProfileManager.mockResolvedValue({
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      });

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await expect(
        invokeCLIAsync(terminal, '/tmp/wt', undefined, () => null, false, { resumeSessionId: 'x; rm -rf ~' })
      ).rejects.toThrow('Invalid Claude Code session id');
      expect(mockWriteToPty).not.toHaveBeenCalled();
      expect(terminal.isCLIMode).toBe(false);
    });

  });
});

describe('task session resume helpers', () => {
  it('builds the resume flag only for plain session ids', async () => {
    const { buildResumeSessionFlag, isValidClaudeSessionId } = await import('../cli-integration-handler');
    expect(buildResumeSessionFlag('0b7c6c1e-1234-4abc-9def-001122334455')).toBe(
      ' --resume 0b7c6c1e-1234-4abc-9def-001122334455'
    );
    expect(isValidClaudeSessionId('abc_123')).toBe(true);
    expect(isValidClaudeSessionId('-abc')).toBe(false);
    expect(isValidClaudeSessionId('a b')).toBe(false);
    expect(isValidClaudeSessionId('$(id)')).toBe(false);
    expect(() => buildResumeSessionFlag("a'b")).toThrow();
  });

  it('only forces a config dir other than the default ~/.claude', async () => {
    const os = await import('os');
    const path = await import('path');
    const { resolveSessionConfigDir } = await import('../cli-integration-handler');
    expect(resolveSessionConfigDir(undefined)).toBeUndefined();
    expect(resolveSessionConfigDir(path.join(os.homedir(), '.claude'))).toBeUndefined();
    expect(resolveSessionConfigDir('~/.claude')).toBeUndefined();
    expect(resolveSessionConfigDir('~/.claude-profiles/work')).toBe(path.join(os.homedir(), '.claude-profiles', 'work'));
  });
});

/**
 * Unit tests for helper functions
 */
describe('cli-integration-handler - Helper Functions', () => {
  describe('buildClaudeShellCommand', () => {
    describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
      beforeEach(() => {
        mockPlatform(platform);
      });

      it('should build default command without cwd or PATH prefix', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand('', '', "'/opt/bin/claude'", { method: 'default' });

        expect(result).toBe("'/opt/bin/claude'\r");
      });

      it('should build command with cwd', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand("cd '/tmp/project' && ", '', "'/opt/bin/claude'", { method: 'default' });

        expect(result).toBe("cd '/tmp/project' && '/opt/bin/claude'\r");
      });

      it('should build command with PATH prefix', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand('', "PATH='/custom/path' ", "'/opt/bin/claude'", { method: 'default' });

        expect(result).toBe("PATH='/custom/path' '/opt/bin/claude'\r");
      });

      it('should build temp-file method command with history-safe prefixes', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand(
          "cd '/tmp/project' && ",
          "PATH='/opt/bin' ",
          "'/opt/bin/claude'",
          { method: 'temp-file', tempFile: '/tmp/.token-123' }
        );

        const clearCmd = getClearPrefix(platform);
        const histPrefix = getHistoryPrefix(platform);
        const tempCmd = getTempFileInvocation(platform, '/tmp/.token-123');
        const cleanupCmd = getTempFileCleanup(platform, '/tmp/.token-123');
        const execCmd = getExecCommand(platform, "'/opt/bin/claude'");

        expect(result).toContain(clearCmd);
        expect(result).toContain("cd '/tmp/project' && ");
        if (platform !== 'win32') {
          expect(result).toContain(histPrefix);
        }
        expect(result).toContain("PATH='/opt/bin' ");
        expect(result).toContain(tempCmd);
        expect(result.endsWith('\r')).toBe(true);
        expect(result).toContain(cleanupCmd);
        expect(result).toContain(execCmd);
      });

      it('should build config-dir method command with CLAUDE_CONFIG_DIR', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand(
          "cd '/tmp/project' && ",
          "PATH='/opt/bin' ",
          "'/opt/bin/claude'",
          { method: 'config-dir', configDir: '/home/user/.claude-work' }
        );

        const clearCmd = getClearPrefix(platform);
        const histPrefix = getHistoryPrefix(platform);
        const configDirVar = getConfigDirCommand(platform, '/home/user/.claude-work');
        const execCmd = getExecCommand(platform, "'/opt/bin/claude'");

        expect(result).toContain(clearCmd);
        expect(result).toContain("cd '/tmp/project' && ");
        if (platform !== 'win32') {
          expect(result).toContain(histPrefix);
        }
        expect(result).toContain(configDirVar);
        expect(result).toContain("PATH='/opt/bin' ");
        expect(result).toContain(execCmd);
      });

      it('should handle empty cwdCommand for temp-file method', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand(
          '',
          '',
          "'/opt/bin/claude'",
          { method: 'temp-file', tempFile: '/tmp/.token' }
        );

        const clearCmd = getClearPrefix(platform);
        const histPrefix = getHistoryPrefix(platform);
        const tempCmd = getTempFileInvocation(platform, '/tmp/.token');

        expect(result).toContain(clearCmd);
        if (platform !== 'win32') {
          expect(result).toContain(histPrefix);
        }
        expect(result).not.toContain('cd ');
        expect(result).toContain(tempCmd);
      });
    });

    it("takes the shell kind's syntax over the platform's", async () => {
      const { buildClaudeShellCommand } = await import('../cli-integration-handler');
      const config = { method: 'config-dir', configDir: '/home/user/.claude-work' } as const;

      mockPlatform('win32');
      expect(buildClaudeShellCommand('', '', "'/opt/bin/claude'", config, undefined, 'posix')).toContain(
        "clear && HISTFILE= HISTCONTROL=ignorespace CLAUDE_CONFIG_DIR='/home/user/.claude-work'"
      );
      mockPlatform('linux');
      expect(buildClaudeShellCommand('', '', '"claude"', config, undefined, 'cmd')).toBe(
        'cls && set "CLAUDE_CONFIG_DIR=/home/user/.claude-work" && "claude"\r'
      );
      expect(buildClaudeShellCommand('', '', "& 'claude'", config, undefined, 'powershell')).toBe(
        "Clear-Host; $env:CLAUDE_CONFIG_DIR = '/home/user/.claude-work'; & 'claude'\r"
      );
    });

    /**
     * The clear only hides the config dir from sight; the history-safe prefixes are what keep the
     * line out of the shell's history, so a caller with something on the screen worth keeping can
     * drop the one and still get the other.
     */
    it('keeps the screen on request without giving up the history protection', async () => {
      const { buildClaudeShellCommand } = await import('../cli-integration-handler');
      const config = { method: 'config-dir', configDir: '/home/user/.claude-work', keepScreen: true } as const;

      expect(buildClaudeShellCommand("cd '/tmp/project' && ", "PATH='/opt/bin' ", "'claude'", config, ' --resume s1', 'posix')).toBe(
        "cd '/tmp/project' && HISTFILE= HISTCONTROL=ignorespace CLAUDE_CONFIG_DIR='/home/user/.claude-work' " +
          `PATH='/opt/bin' bash -c "exec 'claude' --resume s1"\r`
      );
      expect(buildClaudeShellCommand('cd /d "C:\\p" && ', 'set "PATH=C:\\bin" && ', '"claude"', config, ' --resume s1', 'cmd')).toBe(
        'cd /d "C:\\p" && set "CLAUDE_CONFIG_DIR=/home/user/.claude-work" && set "PATH=C:\\bin" && "claude" --resume s1\r'
      );
      expect(buildClaudeShellCommand('', "$env:PATH = 'C:\\bin'; ", "& 'claude'", config, ' --resume s1', 'powershell')).toBe(
        "$env:CLAUDE_CONFIG_DIR = '/home/user/.claude-work'; $env:PATH = 'C:\\bin'; & 'claude' --resume s1\r"
      );

      // The same config without the flag is the one that clears, in every shell's syntax
      for (const shellKind of ['posix', 'cmd', 'powershell'] as const) {
        const clearing = buildClaudeShellCommand('', '', "'claude'", { ...config, keepScreen: false }, undefined, shellKind);
        expect(clearing).toMatch(/^(clear && |cls && |Clear-Host; )/);
      }
    });

    it("runs on Claude Code's default dir by taking CLAUDE_CONFIG_DIR out of the environment", async () => {
      const { buildClaudeShellCommand } = await import('../cli-integration-handler');
      const config = { method: 'default-config-dir' } as const;

      expect(buildClaudeShellCommand("cd '/tmp/project' && ", "PATH='/opt/bin' ", "'claude'", config, ' --resume s1', 'posix')).toBe(
        "cd '/tmp/project' && PATH='/opt/bin' env -u CLAUDE_CONFIG_DIR 'claude' --resume s1\r"
      );
      expect(buildClaudeShellCommand('cd /d "C:\\p" && ', 'set "PATH=C:\\bin" && ', '"claude"', config, ' --resume s1', 'cmd')).toBe(
        'cd /d "C:\\p" && set "CLAUDE_CONFIG_DIR=" && set "PATH=C:\\bin" && "claude" --resume s1\r'
      );
      expect(buildClaudeShellCommand('', "$env:PATH = 'C:\\bin'; ", "& 'claude'", config, ' --resume s1', 'powershell')).toBe(
        "Remove-Item Env:\\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; $env:PATH = 'C:\\bin'; & 'claude' --resume s1\r"
      );

      // Nowhere does it set the variable to the default dir, which would cost the window its sign-in
      for (const shellKind of ['posix', 'cmd', 'powershell'] as const) {
        const command = buildClaudeShellCommand('', '', "'claude'", config, undefined, shellKind);
        expect(command).not.toMatch(/CLAUDE_CONFIG_DIR\s*=\s*[^"\s]/);
        expect(command).not.toContain('.claude');
      }
    });

    it('folds the removal into the `env -u` a WSL window already starts with', async () => {
      const { buildClaudeShellCommand } = await import('../cli-integration-handler');
      // windowClaudeCommand puts `env -u ANTHROPIC_API_KEY` in front of a WSL window's claude; env
      // takes both removals, so no second env wraps the first
      expect(
        buildClaudeShellCommand(
          "cd '/home/me/repo' && ",
          '',
          "env -u ANTHROPIC_API_KEY '/home/me/.local/bin/claude'",
          { method: 'default-config-dir' },
          ' --resume s1',
          'posix'
        )
      ).toBe("cd '/home/me/repo' && env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_API_KEY '/home/me/.local/bin/claude' --resume s1\r");
    });

    it('builds PowerShell commands that Windows PowerShell 5.1 can run (no && anywhere)', async () => {
      const { buildClaudeShellCommand } = await import('../cli-integration-handler');
      const cd = buildCdCommand("C:\\Users\\O'Brien\\my repo", 'powershell');
      const pathPrefix = "$env:PATH = 'C:\\tools;C:\\Program Files\\nodejs'; ";
      const claude = "& 'C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\claude.cmd'";

      expect(buildClaudeShellCommand(cd, pathPrefix, claude, { method: 'default' }, ' --continue', 'powershell')).toBe(
        "Set-Location -LiteralPath 'C:\\Users\\O''Brien\\my repo' -ErrorAction Stop; " +
          "$env:PATH = 'C:\\tools;C:\\Program Files\\nodejs'; " +
          "& 'C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\claude.cmd' --continue\r"
      );

      const configDir = buildClaudeShellCommand(cd, pathPrefix, claude, { method: 'config-dir', configDir: "C:\\cfg\\it's" }, undefined, 'powershell');
      expect(configDir).toBe(
        "Clear-Host; Set-Location -LiteralPath 'C:\\Users\\O''Brien\\my repo' -ErrorAction Stop; " +
          "$env:CLAUDE_CONFIG_DIR = 'C:\\cfg\\it''s'; " +
          "$env:PATH = 'C:\\tools;C:\\Program Files\\nodejs'; " +
          "& 'C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\claude.cmd'\r"
      );

      const tempFile = buildClaudeShellCommand('', '', claude, { method: 'temp-file', tempFile: 'C:\\Temp\\.claude-token-1' }, undefined, 'powershell');
      expect(tempFile).toBe(
        'Clear-Host; ' +
          "$env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content -LiteralPath 'C:\\Temp\\.claude-token-1' -Raw -ErrorAction Stop).Trim(); " +
          "Remove-Item -LiteralPath 'C:\\Temp\\.claude-token-1' -Force -ErrorAction SilentlyContinue; " +
          "& 'C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\claude.cmd'\r"
      );
      for (const command of [configDir, tempFile]) {
        expect(command).not.toContain('&&');
      }
    });
  });

  describe("a terminal's shell kind", () => {
    beforeEach(() => {
      mockWriteToPty.mockClear();
      mockGetClaudeCliInvocation.mockReturnValue({ command: '/opt/bin/claude', env: { PATH: '/usr/bin' } });
      mockGetClaudeProfileManager.mockReturnValue({
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      });
    });

    it('decides the quoting and the exit marker, whatever the platform', async () => {
      const { invokeClaude } = await import('../cli-integration-handler');

      mockPlatform('win32');
      invokeClaude(createMockTerminal({ shellKind: 'posix' }), undefined, undefined, () => null);
      const posix = mockWriteToPty.mock.calls[0][1] as string;
      expect(posix).toContain("'/opt/bin/claude'");
      expect(posix).toContain("printf '\\033]777;workbench-cli-exit\\007'");

      mockPlatform('linux');
      invokeClaude(createMockTerminal({ shellKind: 'cmd' }), undefined, undefined, () => null);
      const cmd = mockWriteToPty.mock.calls[1][1] as string;
      expect(cmd).toContain('"/opt/bin/claude"');
      expect(cmd).not.toContain('workbench-cli-exit');

      invokeClaude(createMockTerminal({ shellKind: 'powershell' }), 'C:\\repo', undefined, () => null);
      const powershell = mockWriteToPty.mock.calls[2][1] as string;
      expect(powershell.startsWith("Set-Location -LiteralPath 'C:\\repo' -ErrorAction Stop; & '/opt/bin/claude' --session-id ")).toBe(true);
      expect(powershell.endsWith('; [Console]::Write("$([char]27)]777;workbench-cli-exit$([char]7)")\r')).toBe(true);
      // The typed line never holds the marker's escape characters, only the CLI's output can
      expect(powershell).not.toContain('\x1b');
    });

    it('quotes the Graphify hint and the self-improve text for PowerShell', async () => {
      const { invokeCLIAsync } = await import('../cli-integration-handler');
      mockPlatform('win32');
      mockGetClaudeCliInvocationAsync.mockResolvedValue({ command: 'claude', env: { PATH: 'C:\\npm' } });
      mockInitializeClaudeProfileManager.mockResolvedValue({
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      });

      await invokeCLIAsync(
        createMockTerminal({
          shellKind: 'powershell',
          graphifyOut: 'C:\\My Repo\\.workbench\\knowledge',
          selfImprove: true,
        }),
        undefined,
        undefined,
        () => null
      );
      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written.startsWith("$env:PATH = 'C:\\npm'; & 'claude' --session-id ")).toBe(true);
      // One flag: Claude Code keeps only the last --append-system-prompt
      expect(written.match(/ --append-system-prompt /g)).toHaveLength(1);
      expect(written).toMatch(/ --append-system-prompt 'The Graphify knowledge graph of this project is in C:\\My Repo\\\.workbench\\knowledge [^']* ## Project memory [^']*'/);
    });
  });

  describe('Workbench messaging tools of an agent window', () => {
    it('hands the window its tools with --mcp-config, pre-approved, its settings, and tells it its name', async () => {
      const { invokeCLIAsync } = await import('../cli-integration-handler');
      mockPlatform('linux');
      mockGetClaudeCliInvocationAsync.mockResolvedValue({ command: '/usr/bin/claude', env: {} });
      mockInitializeClaudeProfileManager.mockResolvedValue({
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      });
      mockWindowToolsConfig.mockResolvedValueOnce("/home/me/.config/Workbench/window-tools/it's/mcp.json");

      await invokeCLIAsync(createMockTerminal({ id: 'abcdef12-0000-0000-0000-000000000000', shellKind: 'posix' }), undefined, undefined, () => null);
      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(
        " --mcp-config '/home/me/.config/Workbench/window-tools/it'\\''s/mcp.json'" +
          " --settings '/home/me/.config/Workbench/window-tools/it'\\''s/settings.json' --allowedTools mcp__workbench"
      );
      expect(written).toContain('In Workbench this agent window is named agent-abcdef12.');
    });
  });

  describe('finalizeClaudeInvoke', () => {
    it('should set terminal title to "Claude" for default profile when terminal has default name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 1' });
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        { name: 'Default', isDefault: true },
        () => mockWindow as any
      );

      expect(terminal.title).toBe('Claude');
    });

    it('should set terminal title to "Claude (ProfileName)" for non-default profile', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 2' });
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        { name: 'Work Profile', isDefault: false },
        () => mockWindow as any
      );

      expect(terminal.title).toBe('Claude (Work Profile)');
    });

    it('should send IPC message to renderer when terminal has default name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 3' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        undefined,
        () => mockWindow as any
      );

      expect(mockSend).toHaveBeenCalledWith(
        expect.stringContaining('title'),
        terminal.id,
        'Claude'
      );
    });

    it('should NOT rename terminal when already named Claude', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Terminal already has Claude title - should NOT be renamed
      const terminal = createMockTerminal({ title: 'Claude' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        { name: 'Work Profile', isDefault: false },
        () => mockWindow as any
      );

      // Title should remain unchanged
      expect(terminal.title).toBe('Claude');
      // No IPC message should be sent for title change
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should NOT rename terminal with user-customized name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // User has customized the terminal name - should NOT be renamed
      const terminal = createMockTerminal({ title: 'My Custom Terminal' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        undefined,
        () => mockWindow as any
      );

      // Title should remain unchanged
      expect(terminal.title).toBe('My Custom Terminal');
      // No IPC message should be sent for title change
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should persist session when terminal has projectPath', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal({ projectPath: '/tmp/project' });

      finalizeClaudeInvoke(
        terminal,
        undefined,
        () => null
      );

      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('should not crash when getWindow returns null', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal();

      expect(() => {
        finalizeClaudeInvoke(
          terminal,
          undefined,
          () => null
        );
      }).not.toThrow();
    });
  });

  describe('shouldAutoRenameTerminal', () => {
    it('should return true for default terminal names', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('Terminal 1')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 2')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 99')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 123')).toBe(true);
    });

    it('should return false for terminals already named Claude', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('Claude')).toBe(false);
      expect(shouldAutoRenameTerminal('Claude (Work)')).toBe(false);
      expect(shouldAutoRenameTerminal('Claude (Profile Name)')).toBe(false);
    });

    it('should return false for user-customized terminal names', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('My Custom Terminal')).toBe(false);
      expect(shouldAutoRenameTerminal('Dev Server')).toBe(false);
      expect(shouldAutoRenameTerminal('Backend')).toBe(false);
    });

    it('should return false for edge cases that do not match the pattern', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      // Terminal 0 is not a valid default (terminals start at 1)
      expect(shouldAutoRenameTerminal('Terminal 0')).toBe(true);  // Pattern matches \d+, so this is valid

      // Lowercase doesn't match
      expect(shouldAutoRenameTerminal('terminal 1')).toBe(false);

      // Extra whitespace doesn't match
      expect(shouldAutoRenameTerminal('Terminal  1')).toBe(false);
      expect(shouldAutoRenameTerminal(' Terminal 1')).toBe(false);
      expect(shouldAutoRenameTerminal('Terminal 1 ')).toBe(false);

      // Tab instead of space doesn't match
      expect(shouldAutoRenameTerminal('Terminal\t1')).toBe(false);
    });
  });
});

describe('agent window sessions', () => {
  beforeEach(() => {
    mockWriteToPty.mockClear();
    mockRecordAgentSession.mockClear();
    mockPlatform('linux');
  });

  it('builds the new session flag only for plain session ids', async () => {
    const { buildNewSessionFlag } = await import('../cli-integration-handler');
    expect(buildNewSessionFlag('0b7c6c1e-1234-4abc-9def-001122334455')).toBe(
      ' --session-id 0b7c6c1e-1234-4abc-9def-001122334455'
    );
    expect(() => buildNewSessionFlag('$(id)')).toThrow();
  });

  it('starts a window session under an id of its own and remembers it for the project', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({ command: 'claude', env: { PATH: '/usr/bin' } });
    mockGetClaudeProfileManager.mockReturnValue({
      getActiveProfile: vi.fn(() => ({
        id: 'work',
        name: 'Work',
        isDefault: false,
        configDir: '~/.claude-profiles/work',
      })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    });

    const terminal = createMockTerminal({ projectPath: '/tmp/project' });
    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(terminal, '/tmp/project', undefined, () => null);

    const written = mockWriteToPty.mock.calls[0][1] as string;
    const sessionId = /--session-id ([0-9a-f-]{36})/.exec(written)?.[1];
    expect(sessionId).toBeTruthy();
    expect(mockRecordAgentSession).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({ sessionId, terminalId: terminal.id, configDir: expect.stringContaining('.claude-profiles') })
    );
  });

  it('clears the window when the user starts Claude on a non-default account', async () => {
    mockGetClaudeCliInvocationAsync.mockResolvedValue({ command: 'claude', env: { PATH: '/usr/bin' } });
    const work = {
      id: 'work',
      name: 'Work',
      isDefault: false,
      configDir: WORK_ACCOUNT_DIR,
    };
    mockInitializeClaudeProfileManager.mockResolvedValue({
      getActiveProfile: vi.fn(() => work),
      getProfile: vi.fn(() => work),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    });

    const { invokeCLIAsync } = await import('../cli-integration-handler');
    await invokeCLIAsync(createMockTerminal({ projectPath: '/tmp/project' }), '/tmp/project', 'work', () => null);

    // A window the user just pressed the button in has no replayed scrollback to lose, so the
    // config dir on the line still goes out of sight the moment Claude starts
    const written = mockWriteToPty.mock.calls[0][1] as string;
    expect(written.startsWith('clear && ')).toBe(true);
    expect(written).toContain(`CLAUDE_CONFIG_DIR=${escapeShellArg(work.configDir)}`);
  });

  it('leaves a resumed task session its own id, and does not count it as a window session', async () => {
    mockGetClaudeCliInvocationAsync.mockResolvedValue({ command: 'claude', env: { PATH: '/usr/bin' } });
    mockInitializeClaudeProfileManager.mockResolvedValue({
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    });

    const terminal = createMockTerminal({ projectPath: '/tmp/project' });
    const { invokeCLIAsync } = await import('../cli-integration-handler');
    await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, false, {
      resumeSessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
      configDir: '~/.claude-profiles/work',
    });

    const written = mockWriteToPty.mock.calls[0][1] as string;
    expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455');
    expect(written).not.toContain('--session-id');
    expect(mockRecordAgentSession).not.toHaveBeenCalled();
  });
});

describe('restoring an agent window', () => {
  beforeEach(() => {
    mockWriteToPty.mockClear();
    mockLastAgentSession.mockReset();
    mockFindSessionTranscript.mockReset();
    mockLatestTranscript.mockReset();
    mockRecordAgentSession.mockClear();
    mockReadAgentSessions.mockReset();
    mockReadAgentSessions.mockResolvedValue([]);
    // No account holds the session at its own path unless a test says so
    mockStat.mockReset();
    mockStat.mockRejectedValue(new Error('ENOENT'));
    mockPlatform('linux');
    mockGetClaudeCliInvocationAsync.mockResolvedValue({ command: 'claude', env: { PATH: '/usr/bin' } });
  });

  const resume = async (terminal: TerminalProcess) => {
    const { resumeClaudeAsync } = await import('../cli-integration-handler');
    await resumeClaudeAsync(terminal, () => null);
    return mockWriteToPty.mock.calls[0][1] as string;
  };

  /** Claude Code's own default config dir, the one it reads only while CLAUDE_CONFIG_DIR is unset */
  const DEFAULT_DIR = path.join(homedir(), '.claude');

  /**
   * A window that started on the work account - whose config dir its shell's environment still
   * carries - whose conversation an account swap left in Claude Code's default dir
   */
  const windowSwappedToDefaultAccount = (sessionId: string) => {
    mockLastAgentSession.mockResolvedValue({
      sessionId,
      configDir: WORK_ACCOUNT_DIR,
      startedAt: '2026-10-21T09:00:00.000Z',
      cwd: '/tmp/project',
    });
    mockFindSessionTranscript.mockImplementation(async (_sessionId: string, dirs: string[]) =>
      dirs[0] === DEFAULT_DIR ? { file: '/t.jsonl', size: 10, modifiedMs: 1 } : null
    );
  };

  it('picks the window\'s own session up again instead of the directory\'s latest', async () => {
    mockLastAgentSession.mockResolvedValue({
      sessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
      startedAt: '2026-10-21T09:00:00.000Z',
      cwd: '/tmp/project',
    });
    mockFindSessionTranscript.mockResolvedValue({ file: '/t.jsonl', size: 10, modifiedMs: 1 });

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455');
    expect(written).not.toContain('--continue');
  });

  it('runs the session on the account whose transcripts hold it, not the one it started on', async () => {
    mockLastAgentSession.mockResolvedValue({
      sessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
      configDir: OTHER_ACCOUNT_DIR,
      startedAt: '2026-10-21T09:00:00.000Z',
      cwd: '/tmp/project',
    });
    // An account swap moved the transcript: it is the other account that holds it now
    mockFindSessionTranscript.mockImplementation(async (_sessionId: string, dirs: string[]) =>
      dirs[0] === WORK_ACCOUNT_DIR ? { file: '/t.jsonl', size: 10, modifiedMs: 1 } : null
    );

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455');
    expect(written).toContain(`CLAUDE_CONFIG_DIR=${escapeShellArg(WORK_ACCOUNT_DIR)}`);
    // The accounts are searched one at a time, so the one that answered is the one to run on, and
    // the wider search is asked without a working directory so it is the project-folder scan alone
    expect(mockFindSessionTranscript).toHaveBeenCalledWith(
      '0b7c6c1e-1234-4abc-9def-001122334455',
      [OTHER_ACCOUNT_DIR]
    );
  });

  /**
   * An account swap copies session files between config dirs, so a stale duplicate under another
   * account is an expected state. The dir that has the transcript where Claude Code writes it for
   * this directory is the one holding the live conversation, whichever dir is looked at first.
   */
  it('prefers the account with the session at its own path over one with a stale copy', async () => {
    const sessionId = '0b7c6c1e-1234-4abc-9def-001122334455';
    mockLastAgentSession.mockResolvedValue({
      sessionId,
      configDir: OTHER_ACCOUNT_DIR,
      startedAt: '2026-10-21T09:00:00.000Z',
      cwd: '/tmp/project',
    });
    // The first account has a copy a swap left in some other project's folder, which only its scan
    // of every project folder finds; the second has the live transcript at the session's own path
    mockFindSessionTranscript.mockImplementation(async (_sessionId: string, dirs: string[]) =>
      dirs[0] === OTHER_ACCOUNT_DIR
        ? { file: path.join(OTHER_ACCOUNT_DIR, 'projects', '-other-project', 'stale.jsonl'), size: 10, modifiedMs: 1 }
        : null
    );
    mockStat.mockImplementation(async (file: string) => {
      if (!file.startsWith(path.join(WORK_ACCOUNT_DIR, 'projects'))) throw new Error('ENOENT');
      return { isFile: () => true };
    });

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain(`--resume ${sessionId}`);
    expect(written).toContain(`CLAUDE_CONFIG_DIR=${escapeShellArg(WORK_ACCOUNT_DIR)}`);
    // Settled before any account was scanned, so the stale copy never got to answer
    expect(mockFindSessionTranscript).not.toHaveBeenCalled();
  });

  /**
   * A swap copies the transcript and deletes nothing, so afterwards the same session id sits at the
   * same relative path under both accounts and the exact-path probe can answer with either. The
   * window's own recorded account is the one the user picked and the one the live conversation is
   * under; the other holds the copy the swap left from before it. Searching the accounts in
   * `claudeConfigDirs`' own order would answer with the default dir, which comes first there, and
   * resume the pre-swap transcript on an account the user never chose.
   */
  it('resumes on the window\'s own account when a swap left the session under the default dir too', async () => {
    const sessionId = '0b7c6c1e-1234-4abc-9def-001122334455';
    const work = WORK_ACCOUNT_DIR;
    /** The window ran on the work account, and both it and the default dir hold the session */
    const sessionUnderBothAccounts = () => {
      mockLastAgentSession.mockResolvedValue({
        sessionId,
        configDir: work,
        startedAt: '2026-10-21T09:00:00.000Z',
        cwd: '/tmp/project',
      });
      mockStat.mockImplementation(async (file: string) => {
        if (file.startsWith(path.join(work, 'projects')) || file.startsWith(path.join(DEFAULT_DIR, 'projects'))) {
          return { isFile: () => true };
        }
        throw new Error('ENOENT');
      });
    };
    const ownAccount = {
      posix: `HISTFILE= HISTCONTROL=ignorespace CLAUDE_CONFIG_DIR=${escapeShellArg(work)} PATH='/usr/bin' bash -c "exec 'claude' --resume ${sessionId}`,
      cmd: `set "CLAUDE_CONFIG_DIR=${work}" && set "PATH=/usr/bin" && "claude" --resume ${sessionId}`,
      powershell: `$env:CLAUDE_CONFIG_DIR = ${psQuote(work)}; $env:PATH = '/usr/bin'; & 'claude' --resume ${sessionId}`,
    };

    for (const shellKind of ['posix', 'cmd', 'powershell'] as const) {
      mockWriteToPty.mockClear();
      sessionUnderBothAccounts();

      const written = await resume(createMockTerminal({ projectPath: '/tmp/project', shellKind }));

      expect(written).toContain(ownAccount[shellKind]);
      // Not the default dir, which would mean running with the variable taken out instead
      expect(written).not.toContain('env -u CLAUDE_CONFIG_DIR');
      expect(written).not.toContain('set "CLAUDE_CONFIG_DIR="');
      expect(written).not.toContain('Remove-Item Env:');
    }
  });

  /**
   * The wider scan runs account by account for the same reason, so it inherits the same order and
   * has to lift the window's own account out of it the same way: a session the swap copied before
   * it was moved into a project folder of its own is findable under both accounts there too.
   */
  it('scans the window\'s own account first in the wider search as well', async () => {
    const sessionId = '0b7c6c1e-1234-4abc-9def-001122334455';
    const work = WORK_ACCOUNT_DIR;
    mockLastAgentSession.mockResolvedValue({
      sessionId,
      configDir: work,
      startedAt: '2026-10-21T09:00:00.000Z',
      cwd: '/tmp/project',
    });
    // No account holds it at the session's own path (`mockStat` rejects everything), and every
    // account's scan of its project folders would find a copy, so the first account asked wins
    mockFindSessionTranscript.mockImplementation(async (_sessionId: string, dirs: string[]) => ({
      file: path.join(dirs[0], 'projects', '-elsewhere', `${sessionId}.jsonl`),
      size: 10,
      modifiedMs: 1,
    }));

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(mockFindSessionTranscript).toHaveBeenCalledTimes(1);
    expect(mockFindSessionTranscript).toHaveBeenCalledWith(sessionId, [work]);
    expect(written).toContain(`CLAUDE_CONFIG_DIR=${escapeShellArg(work)}`);
  });

  it('takes CLAUDE_CONFIG_DIR out of the environment for a session in the default dir', async () => {
    const sessionId = '0b7c6c1e-1234-4abc-9def-001122334455';
    windowSwappedToDefaultAccount(sessionId);

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project', claudeProfileId: 'work' }));

    // Claude Code reads ~/.claude only while the variable is absent, so leaving the work account's
    // dir in place (what "no override" would do) would look for the session under the wrong account
    expect(written).toContain(`env -u CLAUDE_CONFIG_DIR 'claude' --resume ${sessionId}`);
    expect(written).not.toContain('CLAUDE_CONFIG_DIR=');
    expect(written).not.toContain('.claude-profiles/work');
  });

  it('removes the variable in the syntax of the window\'s shell', async () => {
    const sessionId = '0b7c6c1e-1234-4abc-9def-001122334455';

    windowSwappedToDefaultAccount(sessionId);
    const posix = await resume(createMockTerminal({ projectPath: '/tmp/project', shellKind: 'posix' }));
    expect(posix).toContain(`cd '/tmp/project' && PATH='/usr/bin' env -u CLAUDE_CONFIG_DIR 'claude' --resume ${sessionId}`);

    mockWriteToPty.mockClear();
    windowSwappedToDefaultAccount(sessionId);
    const cmd = await resume(createMockTerminal({ projectPath: '/tmp/project', shellKind: 'cmd' }));
    expect(cmd).toContain(`set "CLAUDE_CONFIG_DIR=" && set "PATH=/usr/bin" && "claude" --resume ${sessionId}`);
    expect(cmd).not.toMatch(/CLAUDE_CONFIG_DIR=[^"]/);

    mockWriteToPty.mockClear();
    windowSwappedToDefaultAccount(sessionId);
    const powershell = await resume(createMockTerminal({ projectPath: '/tmp/project', shellKind: 'powershell' }));
    expect(powershell).toContain(
      `Remove-Item Env:\\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; $env:PATH = '/usr/bin'; & 'claude' --resume ${sessionId}`
    );
    expect(powershell).not.toContain('$env:CLAUDE_CONFIG_DIR');
  });

  /**
   * A restore replays the window's own scrollback and only then resumes the session, so the clear
   * the config dir override otherwise starts with would throw away everything the restore just put
   * back. Hiding the dir from sight is worth nothing next to that; keeping the line out of the
   * shell's history, which the prefixes do, costs nothing and stays.
   */
  it('resumes on a non-default account without wiping the replayed scrollback', async () => {
    const sessionId = '0b7c6c1e-1234-4abc-9def-001122334455';
    const work = WORK_ACCOUNT_DIR;
    /** The window's own session, held by the work account at the path Claude Code writes it to */
    const ownSessionOnWorkAccount = () => {
      mockLastAgentSession.mockResolvedValue({
        sessionId,
        configDir: work,
        startedAt: '2026-10-21T09:00:00.000Z',
        cwd: '/tmp/project',
      });
      mockStat.mockImplementation(async (file: string) => {
        if (!file.startsWith(path.join(work, 'projects'))) throw new Error('ENOENT');
        return { isFile: () => true };
      });
    };
    const accountOverride = {
      posix: `HISTFILE= HISTCONTROL=ignorespace CLAUDE_CONFIG_DIR=${escapeShellArg(work)} PATH='/usr/bin' bash -c "exec 'claude' --resume ${sessionId}`,
      cmd: `set "CLAUDE_CONFIG_DIR=${work}" && set "PATH=/usr/bin" && "claude" --resume ${sessionId}`,
      powershell: `$env:CLAUDE_CONFIG_DIR = ${psQuote(work)}; $env:PATH = '/usr/bin'; & 'claude' --resume ${sessionId}`,
    };

    for (const shellKind of ['posix', 'cmd', 'powershell'] as const) {
      mockWriteToPty.mockClear();
      ownSessionOnWorkAccount();

      const written = await resume(createMockTerminal({ projectPath: '/tmp/project', shellKind }));

      expect(written).toContain(accountOverride[shellKind]);
      expect(written).not.toContain('clear && ');
      expect(written).not.toContain('cls && ');
      expect(written).not.toContain('Clear-Host');
    }
  });

  it('adopts the session it would have continued when the window has none of its own', async () => {
    mockLastAgentSession.mockResolvedValue(undefined);
    mockLatestTranscript.mockResolvedValue({
      sessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
      configDir: WORK_ACCOUNT_DIR,
      file: '/t.jsonl',
      size: 10,
      modifiedMs: 1,
    });

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455');
    expect(written).not.toContain('--continue');
    // And on the account the adopted transcript was found under
    expect(written).toContain(`CLAUDE_CONFIG_DIR=${escapeShellArg(WORK_ACCOUNT_DIR)}`);
    // Recorded for the project, so what the conversation spends from here on reaches Metrics
    expect(mockRecordAgentSession).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        sessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
        configDir: WORK_ACCOUNT_DIR,
        cwd: '/tmp/project',
      })
    );
  });

  it('adopts the directory\'s latest session when its own session transcript is gone', async () => {
    mockLastAgentSession.mockResolvedValue({
      sessionId: 'c0ffee00-1234-4abc-9def-001122334455',
      startedAt: '2026-10-21T09:00:00.000Z',
    });
    mockFindSessionTranscript.mockResolvedValue(null);
    mockLatestTranscript.mockResolvedValue({
      sessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
      configDir: OTHER_ACCOUNT_DIR,
      file: '/t.jsonl',
      size: 10,
      modifiedMs: 1,
    });

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455');
  });

  it('leaves the conversation another window is in to that window', async () => {
    mockLastAgentSession.mockResolvedValue(undefined);
    mockReadAgentSessions.mockResolvedValue([
      { sessionId: 'owned-by-another', terminalId: 'other-window', startedAt: '2026-10-21T09:00:00.000Z' },
    ]);
    mockLatestTranscript.mockResolvedValue(null);

    await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(mockLatestTranscript).toHaveBeenCalledWith(expect.anything(), '/tmp/project', new Set(['owned-by-another']));
  });

  it('continues when the directory holds no session at all', async () => {
    mockLastAgentSession.mockResolvedValue(undefined);
    mockLatestTranscript.mockResolvedValue(null);

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--continue');
    expect(mockRecordAgentSession).not.toHaveBeenCalled();
    // No account answered, so the window's environment is left exactly as it is
    expect(written.startsWith("cd '/tmp/project' && PATH='/usr/bin' 'claude' --continue")).toBe(true);
    expect(written).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('continues without adopting a transcript whose name is not a session id', async () => {
    mockLastAgentSession.mockResolvedValue(undefined);
    mockLatestTranscript.mockResolvedValue({
      sessionId: '../../escape',
      configDir: OTHER_ACCOUNT_DIR,
      file: '/t.jsonl',
      size: 10,
      modifiedMs: 1,
    });

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--continue');
    expect(mockRecordAgentSession).not.toHaveBeenCalled();
  });
});
