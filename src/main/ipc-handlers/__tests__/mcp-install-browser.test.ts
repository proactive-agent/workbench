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
  waitForBrowser: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../../settings-utils', () => ({ readSettingsFileAsync: async () => ({ mcpConnectors: { playwrightEnabled: true } }) }));

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
  onMcpAvailabilityChange: vi.fn(),
  recheckMcpConnector: mocks.recheck,
}));
vi.mock('../../browser-profiles/detect', () => ({ detectBrowserProfiles: vi.fn(), waitForManagedBrowser: mocks.waitForBrowser }));
vi.mock('../../window-manager', () => ({ getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] }));
vi.mock('../claude-code-handlers', () => ({ openTerminalWithCommand: mocks.openTerminal }));
vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants/ipc';
import { registerMcpHandlers, terminalNpxCommand } from '../mcp-handlers';

registerMcpHandlers();

const install = (browser: string) =>
  (ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<{ success: boolean; error?: string; data?: { command?: string; alreadyRunning?: boolean } }> })
    .invokeHandler(IPC_CHANNELS.MCP_INSTALL_BROWSER, {}, browser);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wsl = null;
  mocks.windows = false;
  mocks.npx = '/home/me/.nvm/versions/node/v22.1.0/bin/npx';
  mocks.openTerminal.mockResolvedValue(undefined);
  // A download ends at once (never found) unless a test keeps it running
  mocks.waitForBrowser.mockResolvedValue(null);
});

describe('terminalNpxCommand', () => {
  it("runs Workbench's npx by its full path with node's folder on PATH, through env (any login shell)", async () => {
    expect(await terminalNpxCommand('npx -y @playwright/mcp@0.0.83 install-browser firefox')).toEqual({
      command: "env PATH='/home/me/.nvm/versions/node/v22.1.0/bin':\"$PATH\" '/home/me/.nvm/versions/node/v22.1.0/bin/npx' -y @playwright/mcp@0.0.83 install-browser firefox",
    });
  });

  it('runs npx.cmd by its path on Windows (a bare npx resolves the blocked npx.ps1), with the tool PATH', async () => {
    mocks.windows = true;
    mocks.npx = 'C:\\nvm4w\\nodejs\\npx.cmd';
    expect(await terminalNpxCommand('npx -y @playwright/mcp@0.0.83 install-browser firefox')).toEqual({
      command: 'C:\\nvm4w\\nodejs\\npx.cmd -y @playwright/mcp@0.0.83 install-browser firefox',
      env: { PATH: 'C:\\nvm4w\\nodejs;C:\\Windows' },
      windowsBashCommand: "'C:/nvm4w/nodejs/npx' -y @playwright/mcp@0.0.83 install-browser firefox",
    });
  });

  it('quotes a Windows npx path with spaces with the dot operator (the terminal escapes &)', async () => {
    mocks.windows = true;
    mocks.npx = "C:\\Program Files\\node's\\npx.cmd";
    const launch = await terminalNpxCommand('npx -y @playwright/mcp@0.0.83 install-browser chromium');
    expect(launch.command).toBe(". 'C:\\Program Files\\node''s\\npx.cmd' -y @playwright/mcp@0.0.83 install-browser chromium");
    expect(launch.command).not.toMatch(/[&$()]/);
  });

  it("leaves the command to a WSL console's login shell", async () => {
    mocks.wsl = { distro: 'Ubuntu', mountRoot: '/mnt/' };
    expect(await terminalNpxCommand('npx -y @playwright/mcp@0.0.83 install-browser firefox')).toEqual({ command: 'npx -y @playwright/mcp@0.0.83 install-browser firefox' });
  });

  it('fails without npx', async () => {
    mocks.npx = null;
    await expect(terminalNpxCommand('npx -y @playwright/mcp@0.0.83 install-browser firefox')).rejects.toThrow('npx was not found');
  });
});

describe('MCP_INSTALL_BROWSER', () => {
  it("installs the build the pinned Playwright server needs, then sends the new list and checks Playwright again", async () => {
    const profiles = [{ id: 'playwright:webkit', usable: true }];
    let finish: ((list: unknown) => void) | undefined;
    mocks.waitForBrowser.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    expect((await install('webkit')).data).toEqual({ command: 'npx -y @playwright/mcp@0.0.83 install-browser webkit' });
    expect(mocks.openTerminal).toHaveBeenCalledWith(
      expect.stringMatching(/'\/home\/me\/\.nvm\/versions\/node\/v22\.1\.0\/bin\/npx' -y @playwright\/mcp@0\.0\.83 install-browser webkit$/),
      undefined,
      { windowsBashCommand: undefined }
    );
    expect(mocks.waitForBrowser).toHaveBeenCalledWith('webkit');
    expect(mocks.recheck).not.toHaveBeenCalled();
    finish?.(profiles);
    await vi.waitFor(() => expect(mocks.recheck).toHaveBeenCalledWith('playwright', { playwrightEnabled: true }));
    expect(mocks.send).toHaveBeenCalledWith(IPC_CHANNELS.MCP_BROWSER_PROFILES_CHANGED, profiles);
    // Done: a new download may start
    expect((await install('webkit')).data?.alreadyRunning).toBeUndefined();
  });

  it('installs Chromium for the default entry, and refuses unknown browsers', async () => {
    expect((await install('chromium')).data?.command).toBe('npx -y @playwright/mcp@0.0.83 install-browser chromium');
    expect(await install('chrome')).toEqual({ success: false, error: 'Unknown browser' });
    expect(mocks.openTerminal).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Never found: nothing is sent or checked again
    expect(mocks.recheck).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('refuses a second Firefox download while one runs, and allows one after it failed to start', async () => {
    let finish: ((profiles: null) => void) | undefined;
    mocks.waitForBrowser.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
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

  it("an earlier download ending leaves a later download's guard in place", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const finishers: Array<(profiles: null) => void> = [];
      mocks.waitForBrowser.mockImplementation(() => new Promise((resolve) => { finishers.push(resolve); }));
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
      'C:\\nvm4w\\nodejs\\npx.cmd -y @playwright/mcp@0.0.83 install-browser firefox',
      { PATH: 'C:\\nvm4w\\nodejs;C:\\Windows' },
      { windowsBashCommand: "'C:/nvm4w/nodejs/npx' -y @playwright/mcp@0.0.83 install-browser firefox" }
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
