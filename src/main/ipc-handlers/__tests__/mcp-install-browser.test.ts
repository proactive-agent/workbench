/**
 * The browser download button: the install runs with the npx Workbench finds (Node.js from a
 * version manager isn't on a new terminal's PATH), and a terminal that can't open is a failure
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  wsl: null as null | { distro: string; mountRoot: string },
  windows: false,
  npx: '/home/me/.nvm/versions/node/v22.1.0/bin/npx' as string | null,
  openTerminal: vi.fn(),
  recheck: vi.fn(),
  /** Puppeteer's chrome cache folder's entries */
  chromeCache: [] as string[],
  waitForFirefox: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  readdir: vi.fn(async (dir: string) => {
    if (String(dir).endsWith('chrome')) return [...mocks.chromeCache];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));
vi.mock('../../settings-utils', () => ({ readSettingsFileAsync: async () => ({ mcpConnectors: { puppeteerEnabled: true } }) }));

vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  getWslInfo: () => mocks.wsl,
}));
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => mocks.windows,
}));
vi.mock('../../mcp-commands', () => ({
  resolveCommand: vi.fn(async () => mocks.npx),
  findWslCommand: vi.fn(),
  isCommandAvailable: vi.fn(),
}));
vi.mock('../../cli-utils', () => ({ getToolEnvAsync: async () => ({ PATH: 'C:\\nvm4w\\nodejs;C:\\Windows' }) }));
vi.mock('../../mcp-availability', () => ({
  getMcpAvailability: vi.fn(),
  getMcpFixCommand: () => 'npx puppeteer browsers install chrome@131.0.6778.204',
  onMcpAvailabilityChange: vi.fn(),
  recheckMcpConnector: mocks.recheck,
}));
vi.mock('../../browser-profiles/detect', () => ({ detectBrowserProfiles: vi.fn(), waitForManagedFirefox: mocks.waitForFirefox }));
vi.mock('../claude-code-handlers', () => ({ openTerminalWithCommand: mocks.openTerminal }));
vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants/ipc';
import { finishedChromeBuilds, registerMcpHandlers, terminalNpxCommand } from '../mcp-handlers';

registerMcpHandlers();

const install = (browser: string) =>
  (ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<{ success: boolean; error?: string; data?: { alreadyRunning?: boolean } }> })
    .invokeHandler(IPC_CHANNELS.MCP_INSTALL_BROWSER, {}, browser);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wsl = null;
  mocks.windows = false;
  mocks.npx = '/home/me/.nvm/versions/node/v22.1.0/bin/npx';
  mocks.openTerminal.mockResolvedValue(undefined);
  mocks.chromeCache = [];
  // A Firefox download ends at once unless a test keeps it running
  mocks.waitForFirefox.mockResolvedValue(null);
});

describe('terminalNpxCommand', () => {
  it("runs Workbench's npx by its full path with node's folder on PATH, through env (any login shell)", async () => {
    expect(await terminalNpxCommand('npx puppeteer browsers install firefox')).toEqual({
      command: "env PATH='/home/me/.nvm/versions/node/v22.1.0/bin':\"$PATH\" '/home/me/.nvm/versions/node/v22.1.0/bin/npx' puppeteer browsers install firefox",
    });
  });

  it('runs npx.cmd by its path on Windows (a bare npx resolves the blocked npx.ps1), with the tool PATH', async () => {
    mocks.windows = true;
    mocks.npx = 'C:\\nvm4w\\nodejs\\npx.cmd';
    expect(await terminalNpxCommand('npx puppeteer browsers install firefox')).toEqual({
      command: 'C:\\nvm4w\\nodejs\\npx.cmd puppeteer browsers install firefox',
      env: { PATH: 'C:\\nvm4w\\nodejs;C:\\Windows' },
      windowsBashCommand: "'C:/nvm4w/nodejs/npx' puppeteer browsers install firefox",
    });
  });

  it('quotes a Windows npx path with spaces with the dot operator (the terminal escapes &)', async () => {
    mocks.windows = true;
    mocks.npx = "C:\\Program Files\\node's\\npx.cmd";
    const launch = await terminalNpxCommand('npx puppeteer browsers install chrome');
    expect(launch.command).toBe(". 'C:\\Program Files\\node''s\\npx.cmd' puppeteer browsers install chrome");
    expect(launch.command).not.toMatch(/[&$()]/);
  });

  it("leaves the command to a WSL console's login shell", async () => {
    mocks.wsl = { distro: 'Ubuntu', mountRoot: '/mnt/' };
    expect(await terminalNpxCommand('npx puppeteer browsers install firefox')).toEqual({ command: 'npx puppeteer browsers install firefox' });
  });

  it('fails without npx', async () => {
    mocks.npx = null;
    await expect(terminalNpxCommand('npx puppeteer browsers install firefox')).rejects.toThrow('npx was not found');
  });
});

describe('finishedChromeBuilds', () => {
  it('counts a build folder only once its archive is gone', () => {
    expect(finishedChromeBuilds(['linux-131.0.6778.204', '131.0.6778.204-chrome-linux64.zip'])).toEqual([]);
    expect(finishedChromeBuilds(['linux-131.0.6778.204', 'linux-120.0.1'])).toEqual(['linux-131.0.6778.204', 'linux-120.0.1']);
    expect(finishedChromeBuilds(['linux-131.0.6778.204', 'linux-120.0.1'], '131.0.6778.204')).toEqual(['linux-131.0.6778.204']);
  });
});

describe('MCP_INSTALL_BROWSER', () => {
  it("installs the Chrome build Puppeteer's error named, and checks Puppeteer again once it is downloaded", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect((await install('chrome')).success).toBe(true);
      expect(mocks.openTerminal).toHaveBeenCalledWith(
        expect.stringMatching(/'\/home\/me\/\.nvm\/versions\/node\/v22\.1\.0\/bin\/npx' puppeteer browsers install chrome@131\.0\.6778\.204$/),
        undefined,
        { windowsBashCommand: undefined }
      );
      // Still unpacking: not yet
      mocks.chromeCache = ['linux-131.0.6778.204', '131.0.6778.204-chrome-linux64.zip'];
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.recheck).not.toHaveBeenCalled();
      // A second click while it runs opens no other terminal
      expect(await install('chrome')).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ alreadyRunning: true }) }));
      expect(mocks.openTerminal).toHaveBeenCalledTimes(1);

      mocks.chromeCache = ['linux-131.0.6778.204'];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.recheck).toHaveBeenCalledWith('puppeteer', { puppeteerEnabled: true });
      // Done: a new download may start
      expect((await install('chrome')).data?.alreadyRunning).toBeUndefined();
      expect(mocks.openTerminal).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a second Firefox download while one runs, and allows one after it failed to start', async () => {
    let finish: ((profiles: null) => void) | undefined;
    mocks.waitForFirefox.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const [first, second] = await Promise.all([install('firefox'), install('firefox')]);
    expect(first.data?.alreadyRunning).toBeUndefined();
    expect(second.data?.alreadyRunning).toBe(true);
    expect(mocks.openTerminal).toHaveBeenCalledTimes(1);
    finish?.(null);
    await vi.waitFor(async () => expect((await install('firefox')).data?.alreadyRunning).toBeUndefined());
    expect(mocks.openTerminal).toHaveBeenCalledTimes(2);
    // Ends the second download for the next tests
    finish?.(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("checks Puppeteer again at once when the named Chrome build was already downloaded", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.chromeCache = ['linux-131.0.6778.204'];
      expect((await install('chrome')).success).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.recheck).toHaveBeenCalledWith('puppeteer', { puppeteerEnabled: true });
      // and the download is over
      expect((await install('chrome')).data?.alreadyRunning).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an earlier download ending leaves a later download's guard in place", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const finishers: Array<(profiles: null) => void> = [];
      mocks.waitForFirefox.mockImplementation(() => new Promise((resolve) => { finishers.push(resolve); }));
      // The first download's guard runs out (terminal closed?) while its watch goes on
      await install('firefox');
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      expect((await install('firefox')).data?.alreadyRunning).toBeUndefined();
      expect(mocks.openTerminal).toHaveBeenCalledTimes(2);
      // The first watch ends: the second download still counts as running
      finishers[0](null);
      await vi.advanceTimersByTimeAsync(0);
      expect((await install('firefox')).data?.alreadyRunning).toBe(true);
      expect(mocks.openTerminal).toHaveBeenCalledTimes(2);
      finishers[1](null);
      await vi.advanceTimersByTimeAsync(0);
      expect((await install('firefox')).data?.alreadyRunning).toBeUndefined();
      finishers[2]?.(null);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the Windows bash command along to the terminal', async () => {
    mocks.windows = true;
    mocks.npx = 'C:\\nvm4w\\nodejs\\npx.cmd';
    await install('firefox');
    expect(mocks.openTerminal).toHaveBeenCalledWith(
      'C:\\nvm4w\\nodejs\\npx.cmd puppeteer browsers install firefox',
      { PATH: 'C:\\nvm4w\\nodejs;C:\\Windows' },
      { windowsBashCommand: "'C:/nvm4w/nodejs/npx' puppeteer browsers install firefox" }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('reports a terminal that could not open, and lets the next click try again', async () => {
    mocks.openTerminal.mockRejectedValue(new Error('No supported terminal emulator found'));
    expect(await install('firefox')).toEqual({ success: false, error: 'No supported terminal emulator found' });
    mocks.openTerminal.mockResolvedValue(undefined);
    expect((await install('firefox')).data?.alreadyRunning).toBeUndefined();
    expect(mocks.openTerminal).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('reports a missing npx without opening a terminal', async () => {
    mocks.npx = null;
    const result = await install('firefox');
    expect(result.success).toBe(false);
    expect(mocks.openTerminal).not.toHaveBeenCalled();
  });
});
