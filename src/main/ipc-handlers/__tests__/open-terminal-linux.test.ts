/**
 * openTerminalWithCommand on Linux: a terminal that isn't installed (or can't open a window) is
 * skipped for the next common one, and no terminal at all is an error, not a silent success
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  /** Terminals that exist, and the exit code each ends with right away (undefined: stays open) */
  installed: new Map<string, number | undefined>(),
  settings: {} as Record<string, unknown>,
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => false,
  isMacOS: () => false,
  isLinux: () => true,
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
  mocks.spawn.mockImplementation((cmd: string) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    setTimeout(() => {
      if (!mocks.installed.has(cmd)) child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
      else if (mocks.installed.get(cmd) !== undefined) child.emit('exit', mocks.installed.get(cmd));
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
});
