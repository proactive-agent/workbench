import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  commands: new Map<string, string>(),
  wslHome: null as string | null,
  toHost: (p: string) => p,
  runTool: vi.fn(async () => ({ stdout: 'Mozilla Firefox 150.0', stderr: '' })),
}));

vi.mock('../../mcp-commands', () => ({ resolveCommand: async (command: string) => mocks.commands.get(command) ?? null }));
vi.mock('../../platform/runtime-exec', () => ({ runTool: mocks.runTool }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));
vi.mock('../../platform', () => ({ isWindows: () => mocks.wslHome !== null, isMacOS: () => false }));
vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => undefined,
  getWslInfo: () => (mocks.wslHome ? { distro: 'Ubuntu', home: mocks.wslHome } : null),
  toHostPath: (p: string) => mocks.toHost(p),
}));

import { STALE_PROFILE_MS, detectBrowserProfiles, isStaleProfile, scanBrowserProfiles } from '../detect';
import { findManagedBrowser, playwrightCacheDir } from '../managed';

let root: string;

/** The browsers' own profiles (Playwright's downloads are tested apart) */
async function scanUserProfiles(context: Parameters<typeof scanBrowserProfiles>[0]) {
  return (await scanBrowserProfiles(context)).filter((profile) => !profile.managed);
}

/** A path from an OS's table -> where the fixture keeps it */
function fixturePath(p: string): string {
  return path.join(root, p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/'));
}

async function put(p: string, content = ''): Promise<void> {
  const file = fixturePath(p);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function folder(p: string): Promise<void> {
  await mkdir(fixturePath(p), { recursive: true });
}

const localState = (cache: Record<string, { name: string; user_name?: string }>) => JSON.stringify({ profile: { info_cache: cache } });

describe('browser profile detection', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'browser-profiles-'));
    mocks.commands.clear();
    mocks.wslHome = null;
    mocks.toHost = fixturePath;
    mocks.runTool.mockClear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds Windows Chromium and Firefox profiles and marks missing executables', async () => {
    const local = 'C:\\Users\\me\\AppData\\Local';
    await put(`${local}\\Google\\Chrome\\User Data\\Local State`, localState({ Default: { name: 'Me', user_name: 'me@example.com' }, 'Profile 1': { name: 'Work' } }));
    await folder(`${local}\\Google\\Chrome\\User Data\\Default`);
    await folder(`${local}\\Google\\Chrome\\User Data\\Profile 1`);
    await put('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    // Edge's profiles are there, its executable isn't
    await put(`${local}\\Microsoft\\Edge\\User Data\\Local State`, localState({ Default: { name: 'Edge me' } }));
    await folder(`${local}\\Microsoft\\Edge\\User Data\\Default`);
    const roaming = 'C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox';
    await put(`${roaming}\\profiles.ini`, '[Profile0]\r\nName=default-release\r\nIsRelative=1\r\nPath=Profiles/x.default-release\r\n');
    await folder(`${roaming}\\Profiles\\x.default-release`);
    await put('C:\\Program Files\\Mozilla Firefox\\firefox.exe');

    const profiles = await scanUserProfiles({
      os: 'windows',
      home: 'C:\\Users\\me',
      env: { LOCALAPPDATA: local, APPDATA: 'C:\\Users\\me\\AppData\\Roaming', ProgramFiles: 'C:\\Program Files' },
      toHost: fixturePath,
      lookUpCommands: false,
    });

    expect(profiles.map((p) => [p.id, p.usable, p.disabledReason])).toEqual([
      ['chrome:Default', true, undefined],
      ['chrome:Profile 1', true, undefined],
      ['edge:Default', false, 'executable-missing'],
      ['firefox:x.default-release', true, undefined],
    ]);
    expect(profiles[0]).toMatchObject({
      browser: 'chrome',
      engine: 'chromium',
      profileName: 'Me',
      email: 'me@example.com',
      userDataDir: `${local}\\Google\\Chrome\\User Data`,
      profileDirectory: 'Default',
      profilePath: `${local}\\Google\\Chrome\\User Data\\Default`,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    expect(profiles[3]).toMatchObject({
      engine: 'firefox',
      profilePath: `${roaming}\\Profiles\\x.default-release`,
      executablePath: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    });
  });

  it('finds Microsoft Store Firefox by the profiles its package keeps, whatever the package is called', async () => {
    const local = 'C:\\Users\\me\\AppData\\Local';
    const store = `${local}\\Packages\\Some.Firefox_xyz\\LocalCache\\Roaming\\Mozilla\\Firefox`;
    await put(`${store}\\profiles.ini`, '[Profile0]\r\nName=default-release\r\nIsRelative=1\r\nPath=Profiles/s.default-release\r\n');
    await folder(`${store}\\Profiles\\s.default-release`);
    await put(`${local}\\Microsoft\\WindowsApps\\Some.Firefox_xyz\\firefox.exe`);
    // Another app's package, without Firefox profiles
    await folder(`${local}\\Packages\\Microsoft.WindowsCalculator_8wekyb3d8bbwe\\LocalCache`);

    const profiles = await scanUserProfiles({ os: 'windows', home: 'C:\\Users\\me', env: { LOCALAPPDATA: local }, toHost: fixturePath, lookUpCommands: false });

    expect(profiles).toEqual([
      expect.objectContaining({
        id: 'firefox-store:s.default-release',
        variant: 'store',
        usable: true,
        profilePath: `${store}\\Profiles\\s.default-release`,
        executablePath: `${local}\\Microsoft\\WindowsApps\\Some.Firefox_xyz\\firefox.exe`,
      }),
    ]);
  });

  it('lists Safari on macOS as unsupported and skips profiles whose folder is gone', async () => {
    const support = '/Users/me/Library/Application Support';
    await put(`${support}/BraveSoftware/Brave-Browser/Local State`, localState({ Default: { name: 'Brave me' }, 'Profile 3': { name: 'Deleted' } }));
    await folder(`${support}/BraveSoftware/Brave-Browser/Default`);
    await put('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    await put('/Applications/Safari.app/Contents/MacOS/Safari');

    const profiles = await scanUserProfiles({ os: 'macos', home: '/Users/me', env: {}, toHost: fixturePath, lookUpCommands: false });

    expect(profiles.map((p) => [p.id, p.usable, p.disabledReason])).toEqual([
      ['brave:Default', true, undefined],
      ['safari:default', false, 'unsupported-engine'],
    ]);
  });

  it('finds Linux browsers through PATH, snaps, and lists Flatpaks as unusable', async () => {
    await put('/home/me/.config/google-chrome/Local State', localState({ Default: { name: 'Me' } }));
    await folder('/home/me/.config/google-chrome/Default');
    mocks.commands.set('google-chrome', '/usr/bin/google-chrome');
    await put('/home/me/snap/firefox/common/.mozilla/firefox/profiles.ini', '[Profile0]\nName=snappy\nIsRelative=1\nPath=s.default\n');
    await folder('/home/me/snap/firefox/common/.mozilla/firefox/s.default');
    await put('/snap/bin/firefox');
    await put('/snap/firefox/current/usr/lib/firefox/firefox');
    await put('/home/me/.var/app/org.chromium.Chromium/config/chromium/Local State', localState({ Default: { name: 'Flat' } }));
    await folder('/home/me/.var/app/org.chromium.Chromium/config/chromium/Default');
    // Unreadable Local State: that browser is skipped, the others are listed
    await put('/home/me/.config/microsoft-edge/Local State', '{broken');

    const profiles = await scanUserProfiles({ os: 'linux', home: '/home/me', env: {}, toHost: fixturePath, lookUpCommands: true });

    expect(profiles.map((p) => [p.id, p.usable, p.executablePath, p.disabledReason])).toEqual([
      ['chrome:Default', true, '/usr/bin/google-chrome', undefined],
      ['chromium-flatpak:Default', false, undefined, 'sandboxed-package'],
      ['firefox-snap:s.default', true, '/snap/bin/firefox', undefined],
    ]);
    // Profiles with the same name in different installs can be told apart
    expect(profiles.map((p) => p.variant)).toEqual([undefined, 'flatpak', 'snap']);
  });

  it("treats Ubuntu's /usr/bin/firefox script as the snap and checks the snap's binary runs once", async () => {
    await put('/home/me/.mozilla/firefox/profiles.ini', '[Profile0]\nName=deb\nIsRelative=1\nPath=d.default\n');
    await folder('/home/me/.mozilla/firefox/d.default');
    await put('/home/me/snap/firefox/common/.mozilla/firefox/profiles.ini', '[Profile0]\nName=snappy\nIsRelative=1\nPath=s.default\n');
    await folder('/home/me/snap/firefox/common/.mozilla/firefox/s.default');
    await put('/usr/bin/firefox', '#!/bin/sh\nexec /snap/bin/firefox "$@"\n');
    mocks.commands.set('firefox', '/usr/bin/firefox');
    await put('/snap/bin/firefox');
    await put('/snap/firefox/current/usr/lib/firefox/firefox');
    const context = { os: 'linux' as const, home: '/home/me', env: {}, toHost: fixturePath, lookUpCommands: true };

    const profiles = await scanUserProfiles(context);
    expect(profiles.map((p) => [p.id, p.usable, p.executablePath])).toEqual([
      ['firefox:d.default', true, '/snap/bin/firefox'],
      ['firefox-snap:s.default', true, '/snap/bin/firefox'],
    ]);
    expect(mocks.runTool).toHaveBeenCalledTimes(1);
    expect(mocks.runTool).toHaveBeenCalledWith('node', ['--version'], expect.objectContaining({ command: '/snap/firefox/current/usr/lib/firefox/firefox' }));

    // On a system older than the snap's base the binary can't load
    mocks.runTool.mockRejectedValueOnce(Object.assign(new Error('failed'), {
      stderr: "firefox: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by firefox)",
    }));
    const old = await scanUserProfiles({ ...context });
    expect(old.map((p) => [p.usable, p.disabledReason])).toEqual([
      [false, 'snap-needs-newer-glibc'],
      [false, 'snap-needs-newer-glibc'],
    ]);
  });

  it('keeps a real Firefox launcher script as it is', async () => {
    await put('/home/me/.mozilla/firefox/profiles.ini', '[Profile0]\nName=deb\nIsRelative=1\nPath=d.default\n');
    await folder('/home/me/.mozilla/firefox/d.default');
    await put('/usr/bin/firefox', '#!/bin/sh\nexec /usr/lib64/firefox/firefox "$@"\n');
    mocks.commands.set('firefox', '/usr/bin/firefox');

    const profiles = await scanUserProfiles({ os: 'linux', home: '/home/me', env: {}, toHost: fixturePath, lookUpCommands: true });
    expect(profiles.map((p) => [p.usable, p.executablePath])).toEqual([[true, '/usr/bin/firefox']]);
    expect(mocks.runTool).not.toHaveBeenCalled();
  });

  it('leaves out profiles nothing has written to for a year', async () => {
    const dir = '/home/me/.mozilla/firefox';
    await put(`${dir}/profiles.ini`, [
      '[Profile0]', 'Name=old', 'IsRelative=1', 'Path=a.old', '',
      '[Profile1]', 'Name=in-use', 'IsRelative=1', 'Path=b.in-use', '',
      '[Profile2]', 'Name=never-opened', 'IsRelative=1', 'Path=c.fresh',
    ].join('\n'));
    await put(`${dir}/a.old/prefs.js`);
    await put(`${dir}/b.in-use/prefs.js`);
    await folder(`${dir}/c.fresh`);
    const longAgo = new Date(Date.now() - 2 * STALE_PROFILE_MS);
    await utimes(fixturePath(`${dir}/a.old/prefs.js`), longAgo, longAgo);
    await put('/usr/lib/firefox/firefox');

    const profiles = await scanUserProfiles({ os: 'linux', home: '/home/me', env: {}, toHost: fixturePath, lookUpCommands: false });

    expect(profiles.map((p) => p.profileName)).toEqual(['in-use', 'never-opened']);
  });

  it('judges a profile by its activity files, not its folder date', async () => {
    const folderPath = fixturePath('/p/profile');
    await put('/p/profile/prefs.js');
    const longAgo = new Date(Date.now() - 2 * STALE_PROFILE_MS);
    await utimes(`${folderPath}/prefs.js`, longAgo, longAgo);
    // The folder itself was touched just now
    expect(await isStaleProfile(folderPath)).toBe(true);
    // Without activity files the folder date counts
    await folder('/p/empty');
    await utimes(fixturePath('/p/empty'), longAgo, longAgo);
    expect(await isStaleProfile(fixturePath('/p/empty'))).toBe(true);
    expect(await isStaleProfile(fixturePath('/p/missing'))).toBe(false);
  });

  it("lists Playwright's Firefox and WebKit as downloadable until their builds are in the cache, then as usable", async () => {
    const context = { os: 'linux' as const, home: '/home/me', env: {}, toHost: fixturePath, lookUpCommands: false };
    const managed = async () => (await scanBrowserProfiles(context)).filter((p) => p.managed);

    expect(await managed()).toEqual([
      expect.objectContaining({ id: 'playwright:firefox', engine: 'firefox', usable: false, disabledReason: 'not-downloaded', downloadable: 'firefox' }),
      expect.objectContaining({ id: 'playwright:webkit', engine: 'webkit', usable: false, disabledReason: 'not-downloaded', downloadable: 'webkit' }),
    ]);

    // Another version's build doesn't count: the pinned server needs its own
    await put('/home/me/.cache/ms-playwright/firefox-1495/INSTALLATION_COMPLETE');
    await put('/home/me/.cache/ms-playwright/firefox-1495/firefox/firefox');
    await put('/home/me/.cache/ms-playwright/firefox-1553/INSTALLATION_COMPLETE');
    await put('/home/me/.cache/ms-playwright/firefox-1553/firefox/firefox');
    const [firefox, webkit] = await managed();
    expect(firefox).toMatchObject({ usable: true, executablePath: '/home/me/.cache/ms-playwright/firefox-1553/firefox/firefox' });
    expect(firefox.downloadable).toBeUndefined();
    expect(webkit.usable).toBe(false);
  });

  it('skips a Playwright build that is still being unpacked (no INSTALLATION_COMPLETE yet)', async () => {
    const context = { os: 'linux' as const, home: '/home/me', env: {}, toHost: fixturePath, lookUpCommands: false };
    await put('/home/me/.cache/ms-playwright/webkit-2368/pw_run.sh');
    expect(await findManagedBrowser('webkit', context)).toBeUndefined();
    await put('/home/me/.cache/ms-playwright/webkit-2368/INSTALLATION_COMPLETE');
    expect(await findManagedBrowser('webkit', context)).toBe('/home/me/.cache/ms-playwright/webkit-2368/pw_run.sh');
  });

  it("finds the builds in the cache folder each OS uses", async () => {
    await put('/Users/me/Library/Caches/ms-playwright/chromium-1247/INSTALLATION_COMPLETE');
    await put('/Users/me/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    // macOS 14 gets an older WebKit build
    await put('/Users/me/Library/Caches/ms-playwright/webkit_mac14_arm64_special-2251/INSTALLATION_COMPLETE');
    await put('/Users/me/Library/Caches/ms-playwright/webkit_mac14_arm64_special-2251/pw_run.sh');
    const mac = { os: 'macos' as const, home: '/Users/me', env: {}, toHost: fixturePath };
    expect(await findManagedBrowser('chromium', mac))
      .toBe('/Users/me/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    expect(await findManagedBrowser('webkit', mac)).toBe('/Users/me/Library/Caches/ms-playwright/webkit_mac14_arm64_special-2251/pw_run.sh');

    await put('C:\\Users\\me\\AppData\\Local\\ms-playwright\\firefox-1553\\INSTALLATION_COMPLETE');
    await put('C:\\Users\\me\\AppData\\Local\\ms-playwright\\firefox-1553\\firefox\\firefox.exe');
    const windows = await scanBrowserProfiles({ os: 'windows', home: 'C:\\Users\\me', env: {}, toHost: fixturePath, lookUpCommands: false });
    expect(windows.find((p) => p.id === 'playwright:firefox')?.executablePath).toBe('C:\\Users\\me\\AppData\\Local\\ms-playwright\\firefox-1553\\firefox\\firefox.exe');

    // PLAYWRIGHT_BROWSERS_PATH, then XDG_CACHE_HOME on Linux
    const linux = { os: 'linux' as const, home: '/home/me', toHost: fixturePath };
    expect(playwrightCacheDir({ ...linux, env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' } })).toBe('/opt/pw');
    expect(playwrightCacheDir({ ...linux, env: { XDG_CACHE_HOME: '/xdg' } })).toBe('/xdg/ms-playwright');
    expect(playwrightCacheDir({ ...linux, env: { PLAYWRIGHT_BROWSERS_PATH: '0' } })).toBe('/home/me/.cache/ms-playwright');
  });

  it("doesn't list Playwright's downloads for Windows browsers while tools run in WSL", async () => {
    mocks.wslHome = '/home/wsl';
    const profiles = await detectBrowserProfiles({ refresh: true });
    expect(profiles.filter((p) => p.managed).map((p) => p.id)).toEqual(['playwright:firefox', 'playwright:webkit']);
  });

  it("reads the WSL distribution's browsers through host paths, with Linux paths", async () => {
    mocks.wslHome = '/home/wsl';
    await put('/home/wsl/.config/chromium/Local State', localState({ Default: { name: 'In WSL' } }));
    await folder('/home/wsl/.config/chromium/Default');
    await put('/usr/lib/chromium/chromium');

    const profiles = (await detectBrowserProfiles({ refresh: true })).filter((p) => !p.id.startsWith('windows-') && !p.managed);

    expect(profiles).toEqual([
      expect.objectContaining({
        id: 'chromium:Default',
        usable: true,
        executablePath: '/usr/lib/chromium/chromium',
        profilePath: '/home/wsl/.config/chromium/Default',
      }),
    ]);
  });
});
