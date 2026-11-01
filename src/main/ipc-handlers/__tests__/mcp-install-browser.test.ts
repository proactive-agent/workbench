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
}));

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
}));
vi.mock('../../browser-profiles/detect', () => ({ detectBrowserProfiles: vi.fn(), waitForManagedFirefox: vi.fn(async () => null) }));
vi.mock('../claude-code-handlers', () => ({ openTerminalWithCommand: mocks.openTerminal }));
vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants/ipc';
import { registerMcpHandlers, terminalNpxCommand } from '../mcp-handlers';

registerMcpHandlers();

const install = (browser: string) =>
  (ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<{ success: boolean; error?: string }> })
    .invokeHandler(IPC_CHANNELS.MCP_INSTALL_BROWSER, {}, browser);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wsl = null;
  mocks.windows = false;
  mocks.npx = '/home/me/.nvm/versions/node/v22.1.0/bin/npx';
  mocks.openTerminal.mockResolvedValue(undefined);
});

describe('terminalNpxCommand', () => {
  it("runs Workbench's npx by its full path with node's folder on PATH", async () => {
    expect(await terminalNpxCommand('npx puppeteer browsers install firefox')).toEqual({
      command: "PATH='/home/me/.nvm/versions/node/v22.1.0/bin':$PATH '/home/me/.nvm/versions/node/v22.1.0/bin/npx' puppeteer browsers install firefox",
    });
  });

  it("gives a Windows terminal the tool PATH", async () => {
    mocks.windows = true;
    mocks.npx = 'C:\\nvm4w\\nodejs\\npx.cmd';
    expect(await terminalNpxCommand('npx puppeteer browsers install firefox')).toEqual({
      command: 'npx puppeteer browsers install firefox',
      env: { PATH: 'C:\\nvm4w\\nodejs;C:\\Windows' },
    });
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

describe('MCP_INSTALL_BROWSER', () => {
  it("installs the Chrome build Puppeteer's error named", async () => {
    expect((await install('chrome')).success).toBe(true);
    expect(mocks.openTerminal).toHaveBeenCalledWith(
      expect.stringMatching(/'\/home\/me\/\.nvm\/versions\/node\/v22\.1\.0\/bin\/npx' puppeteer browsers install chrome@131\.0\.6778\.204$/),
      undefined
    );
  });

  it('reports a terminal that could not open', async () => {
    mocks.openTerminal.mockRejectedValue(new Error('No supported terminal emulator found'));
    expect(await install('firefox')).toEqual({ success: false, error: 'No supported terminal emulator found' });
  });

  it('reports a missing npx without opening a terminal', async () => {
    mocks.npx = null;
    const result = await install('firefox');
    expect(result.success).toBe(false);
    expect(mocks.openTerminal).not.toHaveBeenCalled();
  });
});
