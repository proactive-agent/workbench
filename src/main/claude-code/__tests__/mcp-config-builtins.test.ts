import { describe, it, expect, vi, beforeEach } from 'vitest';

const platform = { windows: false, wsl: false };

vi.mock('../../platform', () => ({ isWindows: () => platform.windows }));
vi.mock('../../platform/shell-runtime', () => ({
  getWslInfo: () => (platform.wsl ? { distro: 'Ubuntu', tools: { npx: { path: '/usr/bin/npx' } } } : null),
  toRuntimePath: (p: string) => (platform.wsl ? p.replace(/^C:\\/, '/mnt/c/').replace(/\\/g, '/') : p),
}));
vi.mock('../../platform/runtime-exec', () => ({ toRuntimeArg: (arg: string) => arg }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));

import { buildMcpConfig, mcpServerEntry } from '../mcp-config';
import type { PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

const chrome: PuppeteerBrowserChoice = {
  id: 'chrome:Profile 1',
  browser: 'chrome',
  engine: 'chromium',
  profileName: 'Work',
  executablePath: '/opt/google/chrome/chrome',
  userDataDir: '/home/me/.config/google-chrome',
  profileDirectory: 'Profile 1',
  profilePath: '/home/me/.config/google-chrome/Profile 1',
};

const launchOptions = (entry: unknown) =>
  JSON.parse((entry as { env: Record<string, string> }).env.PUPPETEER_LAUNCH_OPTIONS);

describe('built-in MCP servers', () => {
  beforeEach(() => {
    platform.windows = false;
    platform.wsl = false;
  });

  it('runs electron-mcp-server with node where its script has no shebang to rely on', () => {
    const electron = buildMcpConfig(['electron'], undefined).mcpServers.electron;
    expect(electron).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '-p', 'electron-mcp-server', '-c', 'node "$(command -v electron-mcp-server)"'],
    });

    platform.windows = true;
    platform.wsl = true;
    expect(buildMcpConfig(['electron'], undefined).mcpServers.electron).toEqual(electron);
  });

  it("starts electron-mcp-server through npm's shim on Windows", () => {
    platform.windows = true;
    expect(buildMcpConfig(['electron'], undefined).mcpServers.electron).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'electron-mcp-server'],
    });
  });

  it("uses the MCP project's Puppeteer server", () => {
    expect(buildMcpConfig(['puppeteer'], undefined).mcpServers.puppeteer).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    });
  });

  it("launches the chosen Chromium browser with the run's profile copy", () => {
    const settings = { puppeteerBrowser: chrome };
    const entry = buildMcpConfig(['puppeteer'], settings, { browserProfileDir: '/p/.workbench/browser-profiles/chrome_Profile_1/task-1' })
      .mcpServers.puppeteer;
    expect(entry).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] });
    expect(launchOptions(entry)).toEqual({
      executablePath: '/opt/google/chrome/chrome',
      userDataDir: '/p/.workbench/browser-profiles/chrome_Profile_1/task-1',
      args: ['--profile-directory=Profile 1'],
      ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
    });
  });

  it('checks the chosen browser without a profile copy', () => {
    expect(launchOptions(mcpServerEntry('puppeteer', { puppeteerBrowser: chrome }))).toEqual({ executablePath: '/opt/google/chrome/chrome' });
  });

  it('launches Firefox with its profile copy as the user data folder', () => {
    const firefox: PuppeteerBrowserChoice = {
      id: 'firefox:x.default',
      browser: 'firefox',
      engine: 'firefox',
      profileName: 'default',
      executablePath: '/usr/lib/firefox/firefox',
      userDataDir: '/home/me/.mozilla/firefox',
      profilePath: '/home/me/.mozilla/firefox/x.default',
    };
    const entry = buildMcpConfig(['puppeteer'], { puppeteerBrowser: firefox }, { browserProfileDir: '/p/copy' }).mcpServers.puppeteer;
    expect(launchOptions(entry)).toEqual({ executablePath: '/usr/lib/firefox/firefox', browser: 'firefox', userDataDir: '/p/copy' });
  });

  it("launches the snap's own Firefox binary, not the /snap/bin launcher", () => {
    const firefox: PuppeteerBrowserChoice = {
      id: 'firefox-snap:x.default',
      browser: 'firefox',
      engine: 'firefox',
      variant: 'snap',
      profileName: 'default',
      executablePath: '/snap/bin/firefox',
      userDataDir: '/home/me/snap/firefox/common/.mozilla/firefox',
      profilePath: '/home/me/snap/firefox/common/.mozilla/firefox/x.default',
    };
    expect(launchOptions(mcpServerEntry('puppeteer', { puppeteerBrowser: firefox }))).toEqual({
      executablePath: '/snap/firefox/current/usr/lib/firefox/firefox', browser: 'firefox',
    });
  });

  it("launches Puppeteer's own Firefox download without a profile", () => {
    const managed: PuppeteerBrowserChoice = {
      id: 'puppeteer:firefox', browser: 'firefox', engine: 'firefox', managed: true, profileName: 'Firefox',
      executablePath: '/home/me/.cache/puppeteer/firefox/linux-133.0/firefox/firefox', userDataDir: '', profilePath: '',
    };
    expect(launchOptions(buildMcpConfig(['puppeteer'], { puppeteerBrowser: managed }).mcpServers.puppeteer)).toEqual({
      executablePath: '/home/me/.cache/puppeteer/firefox/linux-133.0/firefox/firefox',
      browser: 'firefox',
    });
  });

  it("gives the profile copy's WSL path when tools run in WSL", () => {
    platform.windows = true;
    platform.wsl = true;
    const entry = buildMcpConfig(['puppeteer'], { puppeteerBrowser: chrome }, { browserProfileDir: 'C:\\code\\app\\.workbench\\browser-profiles\\x\\chat' })
      .mcpServers.puppeteer;
    expect(launchOptions(entry).userDataDir).toBe('/mnt/c/code/app/.workbench/browser-profiles/x/chat');
  });
});
