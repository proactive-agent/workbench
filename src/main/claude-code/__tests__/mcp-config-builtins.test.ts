import { describe, it, expect, vi, beforeEach } from 'vitest';

const platform = { windows: false, wsl: false };

vi.mock('../../platform', () => ({ isWindows: () => platform.windows }));
vi.mock('../../platform/shell-runtime', () => ({
  getWslInfo: () => (platform.wsl ? { distro: 'Ubuntu', tools: { npx: { path: '/usr/bin/npx' } } } : null),
  toRuntimePath: (p: string) => (platform.wsl ? p.replace(/^C:\\/, '/mnt/c/').replace(/\\/g, '/') : p),
}));
vi.mock('../../platform/runtime-exec', () => ({ toRuntimeArg: (arg: string) => arg }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));

import { buildMcpConfig, mcpServerEntry, playwrightProfileConfig, playwrightScaleConfig, setPlaywrightDisplayScale, withPlaywrightOutputDir } from '../mcp-config';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';

const chrome: PlaywrightBrowserChoice = {
  id: 'chrome:Profile 1',
  browser: 'chrome',
  engine: 'chromium',
  profileName: 'Work',
  executablePath: '/opt/google/chrome/chrome',
  userDataDir: '/home/me/.config/google-chrome',
  profileDirectory: 'Profile 1',
  profilePath: '/home/me/.config/google-chrome/Profile 1',
};

const PACKAGE = '@playwright/mcp@0.0.83';

const firefox: PlaywrightBrowserChoice = {
  id: 'firefox:x.default',
  browser: 'firefox',
  engine: 'firefox',
  profileName: 'default',
  executablePath: '/usr/lib/firefox/firefox',
  userDataDir: '/home/me/.mozilla/firefox',
  profilePath: '/home/me/.mozilla/firefox/x.default',
};

const snapFirefox: PlaywrightBrowserChoice = {
  ...firefox,
  id: 'firefox-snap:x.default',
  variant: 'snap',
  executablePath: '/snap/bin/firefox',
  userDataDir: '/home/me/snap/firefox/common/.mozilla/firefox',
  profilePath: '/home/me/snap/firefox/common/.mozilla/firefox/x.default',
};

const managed = (engine: 'firefox' | 'webkit'): PlaywrightBrowserChoice => ({
  id: `playwright:${engine}`, browser: engine, engine, managed: true, profileName: engine,
  executablePath: `/home/me/.cache/ms-playwright/${engine}-1/${engine}`, userDataDir: '', profilePath: '',
});

const NO_SYNC = { 'identity.fxaccounts.enabled': false, 'services.sync.username': '' };

describe('built-in MCP servers', () => {
  beforeEach(() => {
    platform.windows = false;
    platform.wsl = false;
    setPlaywrightDisplayScale(null);
  });

  it("renders pages at the screens' pixel density on HiDPI screens", () => {
    const configFiles = { chromium: '/data/playwright/display-scale-chromium.json', other: '/data/playwright/display-scale.json' };
    setPlaywrightDisplayScale({ scale: 2, configFiles });
    expect(mcpServerEntry('playwright', undefined)).toMatchObject({
      args: ['-y', PACKAGE, '--config', configFiles.chromium, '--browser', 'chromium', '--isolated', '--sandbox', '--headless'],
    });
    expect(mcpServerEntry('playwright', { playwrightBrowser: snapFirefox })).toMatchObject({
      args: ['-y', PACKAGE, '--config', configFiles.other, '--browser', 'moz-firefox', '--executable-path', '/snap/firefox/current/usr/lib/firefox/firefox', '--isolated', '--headless'],
    });
    // A profile copy's own config carries it
    expect(playwrightProfileConfig(chrome, '/data/copy')).toMatchObject({
      browser: {
        launchOptions: { args: ['--profile-directory=Profile 1', '--force-device-scale-factor=2'] },
        contextOptions: { deviceScaleFactor: 2 },
      },
    });
    expect(playwrightProfileConfig(firefox, '/data/copy')).toMatchObject({ browser: { contextOptions: { deviceScaleFactor: 2 } } });
    expect(playwrightScaleConfig('chromium', 1.5)).toEqual({
      browser: { contextOptions: { deviceScaleFactor: 1.5 }, launchOptions: { args: ['--force-device-scale-factor=1.5'] } },
    });
    expect(playwrightScaleConfig('other', 2)).toEqual({ browser: { contextOptions: { deviceScaleFactor: 2 } } });

    // A screen of density 1 adds nothing
    setPlaywrightDisplayScale({ scale: 1, configFiles });
    expect(mcpServerEntry('playwright', undefined)).toMatchObject({ args: ['-y', PACKAGE, '--browser', 'chromium', '--isolated', '--sandbox', '--headless'] });
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

  it("runs the pinned Playwright server on Playwright's own Chromium with a profile in memory", () => {
    expect(buildMcpConfig(['playwright'], undefined).mcpServers.playwright).toEqual({
      type: 'stdio',
      command: 'npx',
      // `chromium` is Playwright's Chrome for Testing build, never the installed Chrome
      args: ['-y', PACKAGE, '--browser', 'chromium', '--isolated', '--sandbox', '--headless'],
    });
  });

  it("runs Playwright's own Firefox and WebKit without a profile", () => {
    expect(buildMcpConfig(['playwright'], { playwrightBrowser: managed('firefox') }).mcpServers.playwright)
      .toMatchObject({ args: ['-y', PACKAGE, '--browser', 'firefox', '--isolated', '--headless'] });
    // The run's profile copy is never made for a managed browser, and would be ignored
    expect(buildMcpConfig(['playwright'], { playwrightBrowser: managed('webkit') }, { browserProfileDir: '/p/copy' }).mcpServers.playwright)
      .toMatchObject({ args: ['-y', PACKAGE, '--browser', 'webkit', '--isolated', '--headless'] });
  });

  it("passes the config file in the run's profile copy", () => {
    const entry = buildMcpConfig(['playwright'], { playwrightBrowser: chrome }, { browserProfileDir: '/data/browser-profiles/p/chrome_Profile_1/task-1' })
      .mcpServers.playwright;
    expect(entry).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', PACKAGE, '--config', '/data/browser-profiles/p/chrome_Profile_1/task-1/.workbench-playwright.json', '--headless'],
    });
  });

  it('checks a chosen browser with its executable and a profile in memory', () => {
    expect(mcpServerEntry('playwright', { playwrightBrowser: chrome })).toMatchObject({
      args: ['-y', PACKAGE, '--browser', 'chrome', '--executable-path', '/opt/google/chrome/chrome', '--isolated', '--headless'],
    });
    // The user's Firefox over WebDriver BiDi; snap Firefox through the snap's own binary
    expect(mcpServerEntry('playwright', { playwrightBrowser: snapFirefox })).toMatchObject({
      args: ['-y', PACKAGE, '--browser', 'moz-firefox', '--executable-path', '/snap/firefox/current/usr/lib/firefox/firefox', '--isolated', '--headless'],
    });
  });

  it("launches a chosen Chromium browser's profile folder from the copy, able to decrypt its sign-ins", () => {
    expect(playwrightProfileConfig(chrome, '/data/copy')).toEqual({
      browser: {
        browserName: 'chromium',
        userDataDir: '/data/copy',
        launchOptions: {
          executablePath: '/opt/google/chrome/chrome',
          chromiumSandbox: true,
          args: ['--profile-directory=Profile 1'],
          ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
        },
      },
    });
  });

  it('launches the installed Firefox over WebDriver BiDi with its copy as the profile and Sync off', () => {
    expect(playwrightProfileConfig(firefox, '/data/copy')).toEqual({
      browser: {
        browserName: 'firefox',
        userDataDir: '/data/copy',
        launchOptions: { channel: 'moz-firefox', executablePath: '/usr/lib/firefox/firefox', firefoxUserPrefs: NO_SYNC },
      },
    });
    expect(playwrightProfileConfig(snapFirefox, '/data/copy')).toMatchObject({
      browser: { launchOptions: { executablePath: '/snap/firefox/current/usr/lib/firefox/firefox' } },
    });
  });

  it("runs a Windows Firefox profile in WSL with Playwright's Firefox, letting it open the newer profile", () => {
    platform.windows = true;
    platform.wsl = true;
    const windowsFirefox: PlaywrightBrowserChoice = {
      id: 'windows-firefox-store:m.default-release',
      browser: 'firefox',
      engine: 'firefox',
      profileName: 'default-release',
      variant: 'store',
      executablePath: '/home/me/.cache/ms-playwright/firefox-1553/firefox/firefox',
      userDataDir: 'C:\\Users\\me\\AppData\\Local\\Packages\\Mozilla.Firefox_x\\LocalCache\\Roaming\\Mozilla\\Firefox',
      profilePath: 'C:\\Users\\me\\AppData\\Local\\Packages\\Mozilla.Firefox_x\\LocalCache\\Roaming\\Mozilla\\Firefox\\Profiles\\m.default-release',
    };
    expect(playwrightProfileConfig(windowsFirefox, '/home/me/.cache/workbench/browser-profiles/x/chat')).toEqual({
      browser: {
        browserName: 'firefox',
        userDataDir: '/home/me/.cache/workbench/browser-profiles/x/chat',
        launchOptions: {
          executablePath: '/home/me/.cache/ms-playwright/firefox-1553/firefox/firefox',
          args: ['--allow-downgrade'],
          firefoxUserPrefs: NO_SYNC,
        },
      },
    });
    // Without a copy: Playwright's build by its own name, on a new profile
    expect(buildMcpConfig(['playwright'], { playwrightBrowser: windowsFirefox }).mcpServers.playwright).toMatchObject({
      args: ['-y', PACKAGE, '--browser', 'firefox', '--executable-path', '/home/me/.cache/ms-playwright/firefox-1553/firefox/firefox', '--isolated', '--headless'],
    });
  });

  it("gives the profile copy's WSL paths when tools run in WSL", () => {
    platform.windows = true;
    platform.wsl = true;
    const copy = 'C:\\data\\browser-profiles\\x\\chat';
    expect(buildMcpConfig(['playwright'], { playwrightBrowser: chrome }, { browserProfileDir: copy }).mcpServers.playwright)
      .toMatchObject({ args: ['-y', PACKAGE, '--config', '/mnt/c/data/browser-profiles/x/chat/.workbench-playwright.json', '--headless'] });
    expect(playwrightProfileConfig(chrome, copy)).toMatchObject({ browser: { userDataDir: '/mnt/c/data/browser-profiles/x/chat' } });
  });

  it("sends Playwright's files to the run's folder, leaving other servers alone", () => {
    const servers = buildMcpConfig(['context7', 'playwright'], undefined).mcpServers;
    const withDir = withPlaywrightOutputDir(servers, '/tmp/run/playwright');
    expect(withDir.playwright).toMatchObject({ args: ['-y', PACKAGE, '--browser', 'chromium', '--isolated', '--sandbox', '--headless', '--output-dir', '/tmp/run/playwright'] });
    expect(withDir.context7).toBe(servers.context7);
    expect(withPlaywrightOutputDir(servers, undefined)).toBe(servers);
    // A custom server that happens to be named playwright isn't changed
    const custom = { playwright: { type: 'stdio' as const, command: 'my-browser-server' } };
    expect(withPlaywrightOutputDir(custom, '/tmp/run')).toBe(custom);
  });
});
