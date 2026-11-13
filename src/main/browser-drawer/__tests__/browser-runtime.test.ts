/**
 * Where chat browsers run on Windows (browser-runtime.ts): a chat's choice as its Windows profile,
 * the Playwright build a default profile needs, the autoconfigure script and Node.js on the PATH
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserProfile, PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../settings-utils', () => ({ readSettingsFileAsync: vi.fn(async () => ({})) }));
vi.mock('../../cli-tool-manager', () => ({ getNodeVersionManagerPaths: () => [] }));
const platform = vi.hoisted(() => ({ windows: true, wsl: true }));
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => platform.windows,
}));
vi.mock('../../platform/shell-runtime', () => ({
  getSessionWslInfo: () => (platform.wsl ? { distro: 'Ubuntu' } : null),
  runNatively: <T>(fn: () => T) => fn(),
  whenShellRuntimeReady: async () => undefined,
}));
// No Node.js on Windows
vi.mock('../../utils/windows-paths', () => ({ findWindowsExecutableViaWhereAsync: async () => null }));
const detect = vi.hoisted(() => ({ detectWindowsBrowserProfiles: vi.fn() }));
vi.mock('../../browser-profiles/detect', () => detect);
const builds = vi.hoisted(() => ({ downloaded: new Set<string>() }));
vi.mock('../../browser-profiles/managed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../browser-profiles/managed')>()),
  findManagedBrowser: async (browser: string) => (builds.downloaded.has(browser) ? `C:\\ms-playwright\\${browser}.exe` : undefined),
}));

import {
  autoconfigureScript,
  chatBrowserNode,
  chatBrowsersOnWindows,
  getChatBrowserRequirements,
  managedBuildOf,
  nodeMajor,
  onChatBrowserRequirementsChanged,
  resetChatBrowserRuntimeForTests,
  watchChatBrowserRequirements,
  windowsBrowserChoice,
  withWindowsNodeOnPath,
} from '../browser-runtime';

const profile = (id: string, extra: Partial<BrowserProfile> = {}): BrowserProfile => ({
  id,
  browser: 'edge',
  engine: 'chromium',
  profileName: 'Work',
  userDataDir: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data',
  profileDirectory: 'Default',
  profilePath: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default',
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  usable: true,
  ...extra,
});

const choice = (id: string, extra: Partial<PlaywrightBrowserChoice> = {}): PlaywrightBrowserChoice => ({
  id,
  browser: 'edge',
  engine: 'chromium',
  profileName: 'Work',
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  userDataDir: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data',
  profilePath: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default',
  ...extra,
});

describe('browser runtime', () => {
  beforeEach(() => {
    detect.detectWindowsBrowserProfiles.mockReset();
    builds.downloaded.clear();
    platform.windows = true;
    platform.wsl = true;
    resetChatBrowserRuntimeForTests();
  });

  it('reads the major version of node --version', () => {
    expect(nodeMajor('v22.11.0\r\n')).toBe(22);
    expect(nodeMajor('18.0.0')).toBe(18);
    expect(nodeMajor('nonsense')).toBe(0);
  });

  it("names the Playwright build a default profile needs: its own Chromium unset, none for a user's profile", () => {
    expect(managedBuildOf(undefined)).toBe('chromium');
    expect(managedBuildOf(choice('edge:Default'))).toBeNull();
    expect(managedBuildOf(choice('playwright:firefox', { managed: true, engine: 'firefox', browser: 'firefox' }))).toBe('firefox');
    expect(managedBuildOf(choice('playwright:webkit', { managed: true, engine: 'webkit', browser: 'webkit' }))).toBe('webkit');
  });

  it("runs a chat's WSL-side choice as the same profile on Windows", async () => {
    detect.detectWindowsBrowserProfiles.mockResolvedValue([profile('edge:Default', { signedOut: true })]);
    const native = await windowsBrowserChoice(choice('windows-edge:Default'));
    expect(native).toMatchObject({ id: 'edge:Default', executablePath: profile('edge:Default').executablePath, profileDirectory: 'Default' });
    // A choice made natively (the holder starting again) is found as it is
    expect((await windowsBrowserChoice(native))?.id).toBe('edge:Default');
    // Playwright's own Chromium stays itself, once downloaded on Windows
    await expect(windowsBrowserChoice(undefined)).rejects.toThrow(/install-browser chromium/);
    builds.downloaded.add('chromium');
    expect(await windowsBrowserChoice(undefined)).toBeUndefined();
  });

  it("names the download a Playwright browser that isn't on Windows needs", async () => {
    detect.detectWindowsBrowserProfiles.mockResolvedValue([profile('playwright:firefox', { managed: true, engine: 'firefox', browser: 'firefox', usable: false })]);
    await expect(windowsBrowserChoice(choice('playwright:firefox', { managed: true, engine: 'firefox', browser: 'firefox' })))
      .rejects.toThrow(/install-browser firefox/);
  });

  it("looks again for a profile added since, and names a browser only WSL has", async () => {
    detect.detectWindowsBrowserProfiles
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([profile('playwright:firefox', { managed: true, engine: 'firefox', browser: 'firefox' })]);
    expect((await windowsBrowserChoice(choice('playwright:firefox', { managed: true, engine: 'firefox' })))?.id).toBe('playwright:firefox');
    expect(detect.detectWindowsBrowserProfiles).toHaveBeenLastCalledWith({ refresh: true });

    detect.detectWindowsBrowserProfiles.mockResolvedValue([]);
    await expect(windowsBrowserChoice(choice('chrome:Default', { browser: 'chrome', profileName: 'Linux' }))).rejects.toThrow(/Linux \(chrome\) can't run on Windows/);
  });

  it('installs Node.js only when missing or too old, then fetches the server (with the build a default profile needs)', () => {
    const plain = autoconfigureScript(null);
    expect(plain).toContain('if ($major -lt 20)');
    expect(plain).toContain('winget install --id OpenJS.NodeJS.LTS');
    expect(plain).toMatch(/npx -y --package='@playwright\/mcp@[\d.]+' -- node -e 0/);
    expect(plain).not.toContain('install-browser');
    expect(autoconfigureScript('chromium')).toMatch(/npx -y '@playwright\/mcp@[\d.]+' install-browser chromium/);
    // Windows line endings, for PowerShell 5.1
    expect(plain.split('\r\n').length).toBeGreaterThan(10);
  });

  it("puts Windows' node first on the PATH, under the name the environment has", () => {
    const node = { node: 'C:\\Program Files\\nodejs\\node.exe', npx: 'C:\\Program Files\\nodejs\\npx.cmd', version: 'v22.0.0' };
    expect(withWindowsNodeOnPath({ Path: 'C:\\Windows', OTHER: 'x' }, node)).toEqual({ Path: 'C:\\Program Files\\nodejs;C:\\Windows', OTHER: 'x' });
    expect(withWindowsNodeOnPath({}, node)).toEqual({ PATH: 'C:\\Program Files\\nodejs' });
  });

  it('runs chat browsers on Windows whenever the shell is WSL there, and natively elsewhere', async () => {
    expect(chatBrowsersOnWindows()).toBe(true);
    // None installed: the drawer offers Autoconfigure
    expect(await chatBrowserNode()).toBeNull();
    platform.wsl = false;
    expect(chatBrowsersOnWindows()).toBe(false);
    platform.windows = false;
    platform.wsl = true;
    expect(chatBrowsersOnWindows()).toBe(false);
  });

  it("names what opening a profile needs on Windows, kept until checked again, and nothing elsewhere", async () => {
    expect(await getChatBrowserRequirements(undefined)).toEqual({ missing: ['node', 'browserBuild'], build: 'chromium' });
    expect(await getChatBrowserRequirements(choice('edge:Default'))).toEqual({ missing: ['node'] });
    expect(await getChatBrowserRequirements({ ...choice('playwright:firefox'), managed: true, engine: 'firefox' }))
      .toEqual({ missing: ['node', 'browserBuild'], build: 'firefox' });

    builds.downloaded.add('chromium');
    expect((await getChatBrowserRequirements(undefined)).missing).toEqual(['node', 'browserBuild']);
    expect((await getChatBrowserRequirements(undefined, { refresh: true })).missing).toEqual(['node']);

    platform.windows = false;
    expect(await getChatBrowserRequirements(undefined, { refresh: true })).toEqual({ missing: [] });
  });

  it('checks every few seconds after Autoconfigure, telling the windows when what is missing changes', async () => {
    vi.useFakeTimers();
    try {
      const told = vi.fn();
      onChatBrowserRequirementsChanged(told);
      const firefox = { ...choice('playwright:firefox'), managed: true, engine: 'firefox' };
      expect((await getChatBrowserRequirements(firefox)).missing).toEqual(['node', 'browserBuild']);
      watchChatBrowserRequirements(firefox);

      await vi.advanceTimersByTimeAsync(5000);
      expect(told).not.toHaveBeenCalled();
      // Playwright's Firefox downloaded meanwhile: the next check sees it
      builds.downloaded.add('firefox');
      await vi.advanceTimersByTimeAsync(5000);
      expect(told).toHaveBeenCalledTimes(1);
      expect((await getChatBrowserRequirements(firefox)).missing).toEqual(['node']);
      await vi.advanceTimersByTimeAsync(5000);
      expect(told).toHaveBeenCalledTimes(1);
    } finally {
      resetChatBrowserRuntimeForTests();
      vi.useRealTimers();
    }
  });
});
