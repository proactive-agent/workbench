import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  commands: new Map<string, string>(),
  wslHome: null as string | null,
  toHost: (p: string) => p,
}));

vi.mock('../../mcp-commands', () => ({ resolveCommand: async (command: string) => mocks.commands.get(command) ?? null }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));
vi.mock('../../platform', () => ({ isWindows: () => mocks.wslHome !== null, isMacOS: () => false }));
vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => undefined,
  getWslInfo: () => (mocks.wslHome ? { distro: 'Ubuntu', home: mocks.wslHome } : null),
  toHostPath: (p: string) => mocks.toHost(p),
}));

import { detectBrowserProfiles, scanBrowserProfiles } from '../detect';

let root: string;

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

    const profiles = await scanBrowserProfiles({
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

  it('lists Safari on macOS as unsupported and skips profiles whose folder is gone', async () => {
    const support = '/Users/me/Library/Application Support';
    await put(`${support}/BraveSoftware/Brave-Browser/Local State`, localState({ Default: { name: 'Brave me' }, 'Profile 3': { name: 'Deleted' } }));
    await folder(`${support}/BraveSoftware/Brave-Browser/Default`);
    await put('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    await put('/Applications/Safari.app/Contents/MacOS/Safari');

    const profiles = await scanBrowserProfiles({ os: 'macos', home: '/Users/me', env: {}, toHost: fixturePath, lookUpCommands: false });

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
    await put('/home/me/.var/app/org.chromium.Chromium/config/chromium/Local State', localState({ Default: { name: 'Flat' } }));
    await folder('/home/me/.var/app/org.chromium.Chromium/config/chromium/Default');
    // Unreadable Local State: that browser is skipped, the others are listed
    await put('/home/me/.config/microsoft-edge/Local State', '{broken');

    const profiles = await scanBrowserProfiles({ os: 'linux', home: '/home/me', env: {}, toHost: fixturePath, lookUpCommands: true });

    expect(profiles.map((p) => [p.id, p.usable, p.executablePath, p.disabledReason])).toEqual([
      ['chrome:Default', true, '/usr/bin/google-chrome', undefined],
      ['chromium-flatpak:Default', false, undefined, 'sandboxed-package'],
      ['firefox-snap:s.default', true, '/snap/bin/firefox', undefined],
    ]);
  });

  it("reads the WSL distribution's browsers through host paths, with Linux paths", async () => {
    mocks.wslHome = '/home/wsl';
    await put('/home/wsl/.config/chromium/Local State', localState({ Default: { name: 'In WSL' } }));
    await folder('/home/wsl/.config/chromium/Default');
    await put('/usr/lib/chromium/chromium');

    const profiles = (await detectBrowserProfiles({ refresh: true })).filter((p) => !p.id.startsWith('windows-'));

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
