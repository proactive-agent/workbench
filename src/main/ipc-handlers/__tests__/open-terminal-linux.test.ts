/**
 * openTerminalWithCommand on Linux: a terminal that isn't installed (or can't open a window) is
 * skipped for the next common one, and no terminal at all is an error, not a silent success. On
 * macOS, a command-line terminal that doesn't open falls back to Terminal.app
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  mac: false,
  /** Terminals that exist, and the exit code (or signal) each ends with right away (undefined: stays open) */
  installed: new Map<string, number | NodeJS.Signals | undefined>(),
  settings: {} as Record<string, unknown>,
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => false,
  isMacOS: () => mocks.mac,
  isLinux: () => !mocks.mac,
}));
vi.mock('../../platform/shell-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/shell-runtime')>()),
  isWslRuntime: () => false,
  getWslInfo: () => null,
}));
vi.mock('../../settings-utils', () => ({ readSettingsFile: () => mocks.settings, writeSettingsFile: vi.fn() }));

import { openTerminalWithCommand } from '../claude-code-handlers';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.installed.clear();
  mocks.settings = {};
  mocks.mac = false;
  mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, '', '');
  });
  mocks.spawn.mockImplementation((cmd: string) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    setTimeout(() => {
      if (!mocks.installed.has(cmd)) child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
      else if (typeof mocks.installed.get(cmd) === 'string') child.emit('exit', null, mocks.installed.get(cmd));
      else if (mocks.installed.get(cmd) !== undefined) child.emit('exit', mocks.installed.get(cmd), null);
    }, 0);
    return child;
  });
});

describe('openTerminalWithCommand on Linux', () => {
  it('tries the common terminals until one opens, with the given environment', async () => {
    // gnome-terminal is there but can't open a window; Debian's default terminal works
    mocks.installed.set('gnome-terminal', 1);
    mocks.installed.set('x-terminal-emulator', undefined);
    await openTerminalWithCommand('npx puppeteer browsers install firefox', { PATH: '/opt/node/bin' });
    expect(mocks.spawn.mock.calls.map(([cmd]) => cmd)).toEqual(['gnome-terminal', 'x-terminal-emulator']);
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      'x-terminal-emulator',
      ['-e', 'bash', '-c', 'npx puppeteer browsers install firefox; exec bash'],
      expect.objectContaining({ env: { PATH: '/opt/node/bin' } })
    );
  });

  it('falls back to the common terminals when the preferred one is missing', async () => {
    mocks.settings = { preferredTerminal: 'kitty' };
    mocks.installed.set('xterm', undefined);
    await openTerminalWithCommand('echo hi');
    expect(mocks.spawn.mock.calls[0][0]).toBe('kitty');
    expect(mocks.spawn.mock.calls.at(-1)?.[0]).toBe('xterm');
  });

  it('fails when no terminal opens', async () => {
    await expect(openTerminalWithCommand('echo hi')).rejects.toThrow('No supported terminal emulator found');
  });

  it('counts a terminal stopped by a signal as not opened', async () => {
    mocks.installed.set('gnome-terminal', 'SIGKILL');
    mocks.installed.set('x-terminal-emulator', undefined);
    await openTerminalWithCommand('echo hi');
    expect(mocks.spawn.mock.calls.map(([cmd]) => cmd)).toEqual(['gnome-terminal', 'x-terminal-emulator']);
  });

  it('skips a preferred Hyper or Tabby, which cannot be given the command', async () => {
    for (const preferredTerminal of ['hyper', 'tabby']) {
      mocks.spawn.mockClear();
      mocks.settings = { preferredTerminal };
      mocks.installed.set(preferredTerminal, undefined);
      mocks.installed.set('gnome-terminal', undefined);
      await openTerminalWithCommand('echo hi');
      expect(mocks.spawn.mock.calls.map(([cmd]) => cmd)).toEqual(['gnome-terminal']);
    }
  });
});

describe('openTerminalWithCommand on macOS', () => {
  beforeEach(() => {
    mocks.mac = true;
  });

  it('opens a preferred command-line terminal that starts, without AppleScript', async () => {
    mocks.settings = { preferredTerminal: 'kitty' };
    mocks.installed.set('kitty', undefined);
    await openTerminalWithCommand('echo hi');
    expect(mocks.spawn).toHaveBeenCalledWith('kitty', ['--', 'bash', '-c', 'echo hi'], expect.anything());
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each([
    ['kitty', undefined],
    ['wezterm', undefined],
    ['alacritty', 1],
  ] as const)('falls back to Terminal.app when %s does not open', async (preferredTerminal, exitCode) => {
    mocks.settings = { preferredTerminal };
    // Missing (ENOENT), or `open -a Alacritty` failing for an app that isn't there
    if (exitCode !== undefined) mocks.installed.set('open', exitCode);
    await openTerminalWithCommand('echo hi');
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = mocks.execFile.mock.calls[0];
    expect(file).toBe('osascript');
    expect(args[1]).toContain('tell application "Terminal"');
    expect(args[1]).toContain('do script "echo hi"');
    // Longer than AppleScript's own wait for the Automation prompt
    expect(options.timeout).toBeGreaterThan(120_000);
  });
});
