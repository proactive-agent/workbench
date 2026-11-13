import os from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { hostname } from 'os';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), chmod: vi.fn(actual.chmod) };
});
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn() } }));
const mocks = vi.hoisted(() => ({
  userData: '',
  windows: false,
  wslRoot: '',
  wslDistros: [] as string[],
  wslRunning: '',
  // Whether the chosen browser is open: open by default, so runs copy the live profile and save nothing
  inUse: true,
}));
vi.mock('../in-use', () => ({ isBrowserProfileInUse: async () => mocks.inUse }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }));
vi.mock('../../platform/shell-runtime', () => ({
  toHostPath: (p: string) => p,
  toRuntimePath: (p: string) => p,
  getWslInfo: () => null,
  whenShellRuntimeReady: async () => ({}),
}));
vi.mock('../../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform')>();
  return { ...actual, isWindows: () => mocks.windows || actual.isWindows() };
});
// A distribution's files under the test folder instead of \\wsl.localhost
vi.mock('../../platform/wsl-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/wsl-paths')>();
  return { ...actual, wslToWindows: (p: string, options: { distro: string }) => path.join(mocks.wslRoot, options.distro, p) };
});
vi.mock('../../platform/wsl-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/wsl-detect')>();
  return {
    ...actual,
    checkWslAvailable: async () => ({ available: mocks.wslDistros.length > 0, distros: mocks.wslDistros, checkedAt: 0 }),
  };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    // `wsl.exe -l --running -q`
    execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: Buffer) => void) => {
      callback(null, Buffer.from(mocks.wslRunning));
    }),
  };
});
vi.mock('../../platform/runtime-exec', () => ({ runTool: vi.fn(async () => ({ stdout: '', stderr: '' })) }));

import {
  browserProfileCopiesRoot,
  browserProfileCopyBlocked,
  refreshSavedBrowserProfileCopy,
  browserProfileCopyDir,
  isBrowserProfileCopyPath,
  keepBrowserProfileCopy,
  prepareBrowserProfileCopy,
  removeBrowserProfileCopy,
  removeLeftoverBrowserProfileCopies,
  removeLiveBrowserProfileCopies,
  removeOldBrowserProfileCopies,
  removeStaleBrowserProfileCopies,
  setBrowserProfileCopyExtensions,
} from '../profile-copy';

const isPosix = process.platform !== 'win32';

let root: string;

async function put(file: string, content = 'x'): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** A process id nothing runs as */
const DEAD_PID = 2 ** 22 + 12345;
const OWNER_FILE = '.workbench-copy-owner.json';

/** A copy owned by a Workbench process that is gone (a crash) */
async function leftover(dir: string, file: string): Promise<void> {
  await put(path.join(dir, file));
  await put(path.join(dir, OWNER_FILE), JSON.stringify({ pid: DEAD_PID, host: hostname() }));
}

describe('browser profile copies', () => {
  const realHome = process.env.HOME;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'profile-copy-'));
    mocks.userData = path.join(root, 'userData');
    mocks.windows = false;
    mocks.wslRoot = path.join(root, 'wsl');
    mocks.wslDistros = [];
    mocks.wslRunning = '';
    mocks.inUse = true;
    // Snap copies go to the home's ~/snap: the test's own home instead of the user's
    process.env.HOME = path.join(root, 'home');
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps a crashed chat browser's copy for its chat through every sweep, and quitting leaves it", async () => {
    const project = path.join(root, 'project');
    const choice: PlaywrightBrowserChoice = {
      id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Default',
      executablePath: '/opt/google/chrome/chrome', userDataDir: path.join(root, 'chrome'), profileDirectory: 'Default',
      profilePath: path.join(root, 'chrome', 'Default'),
    };
    const kept = browserProfileCopyDir(project, choice, 'chat-kept');
    const other = browserProfileCopyDir(project, choice, 'chat-other');
    await leftover(kept, 'Cookies');
    await leftover(other, 'Cookies');
    expect(isBrowserProfileCopyPath(kept)).toBe(true);
    expect(isBrowserProfileCopyPath(path.join(root, 'home'))).toBe(false);
    expect(isBrowserProfileCopyPath(path.dirname(kept))).toBe(false);

    expect(await keepBrowserProfileCopy(kept)).toBe(true);
    // This process holds it now
    expect(JSON.parse(await readFile(path.join(kept, OWNER_FILE), 'utf-8'))).toMatchObject({ pid: process.pid });
    await removeLeftoverBrowserProfileCopies([project]);
    await removeOldBrowserProfileCopies(project, { force: true, keep: [] });
    await removeLiveBrowserProfileCopies();
    expect(existsSync(path.join(kept, 'Cookies'))).toBe(true);
    expect(existsSync(other)).toBe(false);
    // Nothing to keep where there is no copy
    expect(await keepBrowserProfileCopy(other)).toBe(false);
    await removeBrowserProfileCopy(kept);
  });

  it('copies a Chromium profile with Local State, leaving out caches and locks', async () => {
    const userData = path.join(root, 'chrome');
    const profile = path.join(userData, 'Profile 1');
    await put(path.join(userData, 'Local State'), '{"os_crypt":{}}');
    await put(path.join(userData, 'SingletonLock'));
    await put(path.join(profile, 'Cookies'), 'cookies');
    await put(path.join(profile, 'Network', 'Cookies'), 'network cookies');
    await put(path.join(profile, 'Cache', 'data_0'));
    await put(path.join(profile, 'Service Worker', 'CacheStorage', 'blob'));
    await put(path.join(profile, 'Service Worker', 'Database', 'db'));
    await put(path.join(profile, 'lockfile'));
    const choice: PlaywrightBrowserChoice = {
      id: 'chrome:Profile 1',
      browser: 'chrome',
      engine: 'chromium',
      profileName: 'Work',
      executablePath: '/opt/google/chrome/chrome',
      userDataDir: userData,
      profileDirectory: 'Profile 1',
      profilePath: profile,
    };
    const project = path.join(root, 'project');

    const copy = await prepareBrowserProfileCopy(project, choice, 'task-001-x');

    // In the app's data folder, never in the project (Claude sessions read the project)
    expect(path.dirname(path.dirname(path.dirname(copy!)))).toBe(path.join(mocks.userData, 'browser-profiles'));
    expect(copy!.startsWith(project)).toBe(false);
    expect(copy).toBe(path.join(browserProfileCopiesRoot(project), 'chrome_Profile_1', 'task-001-x'));
    expect(path.basename(browserProfileCopiesRoot(project))).toMatch(/^project-[0-9a-f]{16}$/);
    expect(browserProfileCopiesRoot(path.join(root, 'other', 'project'))).not.toBe(browserProfileCopiesRoot(project));
    expect(JSON.parse(await readFile(path.join(copy!, OWNER_FILE), 'utf-8'))).toMatchObject({ pid: process.pid, host: hostname() });
    expect(copy).toBe(browserProfileCopyDir(project, choice, 'task-001-x'));
    const copied = (...parts: string[]) => path.join(copy!, ...parts);
    expect(await readFile(copied('Local State'), 'utf-8')).toBe('{"os_crypt":{}}');
    expect(existsSync(copied('First Run'))).toBe(true);
    expect(await readFile(copied('Profile 1', 'Cookies'), 'utf-8')).toBe('cookies');
    expect(await readFile(copied('Profile 1', 'Network', 'Cookies'), 'utf-8')).toBe('network cookies');
    expect(existsSync(copied('Profile 1', 'Service Worker', 'Database', 'db'))).toBe(true);
    expect(existsSync(copied('Profile 1', 'Cache'))).toBe(false);
    expect(existsSync(copied('Profile 1', 'Service Worker', 'CacheStorage'))).toBe(false);
    expect(existsSync(copied('Profile 1', 'lockfile'))).toBe(false);
    expect(existsSync(copied('SingletonLock'))).toBe(false);
    // The run's Playwright config: the browser's executable with this copy as its profile
    expect(JSON.parse(await readFile(copied('.workbench-playwright.json'), 'utf-8'))).toMatchObject({
      browser: {
        browserName: 'chromium',
        userDataDir: copy,
        launchOptions: { executablePath: '/opt/google/chrome/chrome', args: ['--profile-directory=Profile 1'] },
      },
    });

    // A new run starts from a fresh copy
    await put(copied('Profile 1', 'stale'));
    await prepareBrowserProfileCopy(project, choice, 'task-001-x');
    expect(existsSync(copied('Profile 1', 'stale'))).toBe(false);

    await removeBrowserProfileCopy(copy!);
    expect(existsSync(copy!)).toBe(false);
  });

  it('copies a Firefox profile folder as the user data folder, without its lock and caches', async () => {
    const profile = path.join(root, 'firefox', 'x.default-release');
    await put(path.join(profile, 'cookies.sqlite'), 'jar');
    await put(path.join(profile, 'parent.lock'));
    await put(path.join(profile, 'cache2', 'entries', 'a'));
    const choice: PlaywrightBrowserChoice = {
      id: 'firefox:x.default-release',
      browser: 'firefox',
      engine: 'firefox',
      profileName: 'default-release',
      executablePath: '/usr/lib/firefox/firefox',
      userDataDir: path.join(root, 'firefox'),
      profilePath: profile,
    };

    const copy = await prepareBrowserProfileCopy(path.join(root, 'project'), choice, 'chat');

    expect(await readFile(path.join(copy!, 'cookies.sqlite'), 'utf-8')).toBe('jar');
    expect(existsSync(path.join(copy!, 'parent.lock'))).toBe(false);
    expect(existsSync(path.join(copy!, 'cache2'))).toBe(false);
  });

  it("runs a profile's extensions only when asked: Chromium's from the profile, Firefox's left out otherwise", async () => {
    const userData = path.join(root, 'chrome');
    const chromeProfile = path.join(userData, 'Default');
    await put(path.join(chromeProfile, 'Extensions', 'abc', '1.0', 'cache', 'manifest.json'), '{}');
    await put(path.join(userData, 'Local State'), '{}');
    const chrome: PlaywrightBrowserChoice = {
      id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Default',
      executablePath: '/opt/google/chrome/chrome', userDataDir: userData, profileDirectory: 'Default', profilePath: chromeProfile,
    };
    const firefoxProfile = path.join(root, 'firefox', 'x.default-release');
    await put(path.join(firefoxProfile, 'extensions', 'addon@example.xpi'));
    const firefox: PlaywrightBrowserChoice = {
      id: 'firefox:x.default-release', browser: 'firefox', engine: 'firefox', profileName: 'default-release',
      executablePath: '/usr/lib/firefox/firefox', userDataDir: path.join(root, 'firefox'), profilePath: firefoxProfile,
    };
    const project = path.join(root, 'project');
    const config = async (copy: string) => JSON.parse(await readFile(path.join(copy, '.workbench-playwright.json'), 'utf-8'));
    const chromeExtension = (copy: string) => path.join(copy, 'Default', 'Extensions', 'abc', '1.0', 'cache', 'manifest.json');

    // Task runs: as before (Chromium without, Firefox with the copied ones)
    const task = (await prepareBrowserProfileCopy(project, chrome, 'task-1'))!;
    expect(existsSync(chromeExtension(task))).toBe(false);
    expect((await config(task)).browser.launchOptions.ignoreDefaultArgs).not.toContain('--disable-extensions');
    expect(existsSync(path.join((await prepareBrowserProfileCopy(project, firefox, 'task-1'))!, 'extensions', 'addon@example.xpi'))).toBe(true);

    // A chat browser with the switch on: every file of the extension (its own `cache` folder too)
    const on = (await prepareBrowserProfileCopy(project, chrome, 'chat-on', undefined, { extensions: true }))!;
    expect(existsSync(chromeExtension(on))).toBe(true);
    expect((await config(on)).browser.launchOptions.ignoreDefaultArgs).toContain('--disable-extensions');
    expect(existsSync(path.join((await prepareBrowserProfileCopy(project, firefox, 'chat-on', undefined, { extensions: true }))!, 'extensions'))).toBe(true);

    // Off: none in either copy
    const off = (await prepareBrowserProfileCopy(project, firefox, 'chat-off', undefined, { extensions: false }))!;
    expect(existsSync(path.join(off, 'extensions'))).toBe(false);

    // A kept copy follows the switch as it is now: off drops them, on takes them back
    await setBrowserProfileCopyExtensions(chrome, on, false);
    expect(existsSync(path.join(on, 'Default', 'Extensions'))).toBe(false);
    expect((await config(on)).browser.launchOptions.ignoreDefaultArgs).not.toContain('--disable-extensions');
    await setBrowserProfileCopyExtensions(firefox, off, true);
    expect(existsSync(path.join(off, 'extensions', 'addon@example.xpi'))).toBe(true);
    expect(existsSync(path.join(off, 'extensions.partial'))).toBe(false);

    // While the browser is open, runs copy its saved copy, which keeps the extensions its settings name
    mocks.inUse = false;
    await refreshSavedBrowserProfileCopy(chrome);
    mocks.inUse = true;
    await rm(path.join(chromeProfile, 'Extensions'), { recursive: true });
    expect(existsSync(chromeExtension((await prepareBrowserProfileCopy(project, chrome, 'chat-saved', undefined, { extensions: true }))!))).toBe(true);
    expect(existsSync(path.join((await prepareBrowserProfileCopy(project, chrome, 'task-2'))!, 'Default', 'Extensions'))).toBe(false);
  });

  it("removes a task's older copies, keeping the current run's and other tasks'", async () => {
    const profile = path.join(root, 'chrome', 'Default');
    await put(path.join(profile, 'Cookies'));
    const choice: PlaywrightBrowserChoice = {
      id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Me',
      executablePath: '/opt/google/chrome/chrome', userDataDir: path.join(root, 'chrome'), profileDirectory: 'Default', profilePath: profile,
    };
    const project = path.join(root, 'project');
    // Left by a crash: no live run uses it
    const old = browserProfileCopyDir(project, choice, 'task-001-a-aaaa');
    await leftover(old, 'Default/Cookies');
    // A newer launch of the task, still copying or running
    const live = await prepareBrowserProfileCopy(project, choice, 'task-001-a-dddd');
    const other = await prepareBrowserProfileCopy(project, choice, 'task-002-b-bbbb');
    const current = await prepareBrowserProfileCopy(project, choice, 'task-001-a-cccc');

    await removeStaleBrowserProfileCopies(project, choice, 'task-001-a-', 'task-001-a-cccc');

    expect(existsSync(old)).toBe(false);
    expect(existsSync(live!)).toBe(true);
    expect(existsSync(other!)).toBe(true);
    expect(existsSync(current!)).toBe(true);
  });

  it('keeps the copy private and leaves out the session to restore and nested caches', async () => {
    const userData = path.join(root, 'chrome');
    const profile = path.join(userData, 'Default');
    await put(path.join(profile, 'Cookies'));
    await put(path.join(profile, 'Sessions', 'Session_1'));
    await put(path.join(profile, 'Current Session'));
    await put(path.join(profile, 'Last Tabs'));
    await put(path.join(profile, 'Storage', 'ext', 'abc', 'def', 'Code Cache', 'js'));
    await put(path.join(profile, 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1, startup_urls: ['https://mail'] }, other: 1 }));
    const choice: PlaywrightBrowserChoice = {
      id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Me',
      executablePath: '/opt/google/chrome/chrome', userDataDir: userData, profileDirectory: 'Default', profilePath: profile,
    };
    const project = path.join(root, 'project');
    // Made before copies were private
    await mkdir(browserProfileCopiesRoot(project), { recursive: true, mode: 0o755 });

    const copy = (await prepareBrowserProfileCopy(project, choice, 'chat-1'))!;

    expect(existsSync(path.join(copy, 'Default', 'Cookies'))).toBe(true);
    for (const left of ['Sessions', 'Current Session', 'Last Tabs', 'Storage/ext/abc/def/Code Cache']) {
      expect(existsSync(path.join(copy, 'Default', left))).toBe(false);
    }
    const prefs = JSON.parse(await readFile(path.join(copy, 'Default', 'Preferences'), 'utf-8'));
    expect(prefs).toEqual({ session: { restore_on_startup: 5, startup_urls: [] }, other: 1 });
    if (isPosix) {
      const projectRoot = browserProfileCopiesRoot(project);
      for (const dir of [path.dirname(projectRoot), projectRoot, path.dirname(copy), copy, path.join(copy, 'Default')]) {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
      }
    }
  });

  it("leaves out Firefox's session, Sync account and per-site caches", async () => {
    const profile = path.join(root, 'firefox', 'x.default-release');
    await put(path.join(profile, 'cookies.sqlite'));
    await put(path.join(profile, 'sessionstore.jsonlz4'));
    await put(path.join(profile, 'sessionstore-backups', 'recovery.jsonlz4'));
    await put(path.join(profile, 'signedInUser.json'));
    await put(path.join(profile, 'weave', 'bookmarks.sqlite'));
    await put(path.join(profile, 'storage', 'default', 'https+++a.com', 'cache', 'caches.sqlite'));
    await put(path.join(profile, 'storage', 'default', 'https+++a.com', 'idb', 'db.sqlite'));
    const choice: PlaywrightBrowserChoice = {
      id: 'firefox:x', browser: 'firefox', engine: 'firefox', profileName: 'x',
      executablePath: '/usr/lib/firefox/firefox', userDataDir: path.join(root, 'firefox'), profilePath: profile,
    };

    const copy = (await prepareBrowserProfileCopy(path.join(root, 'project'), choice, 'chat-1'))!;

    expect(existsSync(path.join(copy, 'cookies.sqlite'))).toBe(true);
    expect(existsSync(path.join(copy, 'storage', 'default', 'https+++a.com', 'idb', 'db.sqlite'))).toBe(true);
    for (const left of ['sessionstore.jsonlz4', 'sessionstore-backups', 'signedInUser.json', 'weave', 'storage/default/https+++a.com/cache']) {
      expect(existsSync(path.join(copy, left))).toBe(false);
    }
  });

  it('removes a partial copy when the disk is full', async () => {
    const profile = path.join(root, 'firefox', 'x');
    await put(path.join(profile, 'cookies.sqlite'));
    const choice: PlaywrightBrowserChoice = {
      id: 'firefox:x', browser: 'firefox', engine: 'firefox', profileName: 'x',
      executablePath: '/usr/lib/firefox/firefox', userDataDir: path.join(root, 'firefox'), profilePath: profile,
    };
    const project = path.join(root, 'project');
    vi.mocked(fsPromises.copyFile).mockRejectedValueOnce(Object.assign(new Error('no space'), { code: 'ENOSPC' }));

    await expect(prepareBrowserProfileCopy(project, choice, 'task-001-x')).rejects.toThrow('no space');

    expect(existsSync(browserProfileCopyDir(project, choice, 'task-001-x'))).toBe(false);
  });

  it("removes a project's copies older than a day that no live run uses, for any profile", async () => {
    const project = path.join(root, 'project');
    const copies = browserProfileCopiesRoot(project);
    const dayAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const oldOther = path.join(copies, 'firefox_y', 'chat');
    const recent = path.join(copies, 'firefox_y', 'task-003-c-1234');
    await leftover(oldOther, 'cookies.sqlite');
    await leftover(recent, 'cookies.sqlite');
    await utimes(oldOther, dayAgo, dayAgo);

    await removeOldBrowserProfileCopies(project, { force: true });

    expect(existsSync(oldOther)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("removes an earlier choice's copies at once, keeping the current profile's recent ones and live runs'", async () => {
    const profile = path.join(root, 'chrome', 'Default');
    await put(path.join(profile, 'Cookies'));
    const choice: PlaywrightBrowserChoice = {
      id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Me',
      executablePath: '/opt/google/chrome/chrome', userDataDir: path.join(root, 'chrome'), profileDirectory: 'Default', profilePath: profile,
    };
    const project = path.join(root, 'project');
    const copies = browserProfileCopiesRoot(project);
    const dayAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const otherProfile = path.join(copies, 'firefox_y', 'task-003-c-1234');
    const oldSame = path.join(copies, 'chrome_Default', 'chat-old');
    const recentSame = path.join(copies, 'chrome_Default', 'chat-recent');
    await leftover(otherProfile, 'cookies.sqlite');
    await leftover(oldSame, 'Default/Cookies');
    await leftover(recentSame, 'Default/Cookies');
    await utimes(oldSame, dayAgo, dayAgo);
    const live = (await prepareBrowserProfileCopy(project, choice, 'task-004-d-5678'))!;
    await utimes(live, dayAgo, dayAgo);

    await removeOldBrowserProfileCopies(project, { force: true, keep: [choice] });

    expect(existsSync(otherProfile)).toBe(false);
    expect(existsSync(oldSame)).toBe(false);
    expect(existsSync(recentSame)).toBe(true);
    expect(existsSync(live)).toBe(true);
    await removeBrowserProfileCopy(live);
  });

  it("removes a project's copies when runs use Playwright's own browser", async () => {
    const project = path.join(root, 'project');
    const recent = path.join(browserProfileCopiesRoot(project), 'chrome_Default', 'chat-1');
    await leftover(recent, 'Default/Cookies');
    const managed: PlaywrightBrowserChoice = {
      id: 'playwright:firefox', browser: 'firefox', engine: 'firefox', managed: true, profileName: 'Firefox',
      executablePath: '/c/firefox', userDataDir: '', profilePath: '',
    };
    expect(await prepareBrowserProfileCopy(project, managed, 'chat-2')).toBeNull();
    await vi.waitFor(() => expect(existsSync(recent)).toBe(false));
  });

  it('removes every leftover copy at startup, of every project, and the copies earlier versions kept in projects', async () => {
    const a = path.join(browserProfileCopiesRoot(path.join(root, 'a')), 'chrome_Default', 'chat-1');
    const b = path.join(browserProfileCopiesRoot(path.join(root, 'b')), 'firefox_x', 'task-001-x-1');
    // A project since removed from the app
    const gone = path.join(browserProfileCopiesRoot(path.join(root, 'gone')), 'firefox_x', 'chat-2');
    await leftover(a, 'Default/Cookies');
    await leftover(b, 'cookies.sqlite');
    await leftover(gone, 'cookies.sqlite');
    // Kept inside the project by an earlier version (no owner file), from a while ago
    const legacyRoot = path.join(root, 'a', '.workbench', 'browser-profiles');
    const legacy = path.join(legacyRoot, 'chrome_Default', 'chat-1');
    await put(path.join(legacy, 'Default', 'Cookies'));
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(legacy, hourAgo, hourAgo);

    await removeLeftoverBrowserProfileCopies([path.join(root, 'a'), path.join(root, 'b'), path.join(root, 'none')]);

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(legacyRoot)).toBe(false);
    expect(existsSync(path.join(root, 'a', '.workbench'))).toBe(true);
  });

  it("never sweeps a copy another running Workbench process owns, at startup or for another choice", async () => {
    const project = path.join(root, 'project');
    const copies = browserProfileCopiesRoot(project);
    // Owned by a process that runs (this test's parent), as by `npm run dev` next to the installed app
    const others = path.join(copies, 'firefox_y', 'task-003-c-1234');
    await put(path.join(others, 'cookies.sqlite'));
    await put(path.join(others, OWNER_FILE), JSON.stringify({ pid: process.ppid, host: hostname() }));
    // Being set up by another process: no owner file yet
    const settingUp = path.join(copies, 'firefox_y', 'chat-9');
    await put(path.join(settingUp, 'cookies.sqlite'));
    // Kept in the project by an earlier version that may still run (no owner file, recent)
    const legacyRoot = path.join(project, '.workbench', 'browser-profiles');
    const legacyFresh = path.join(legacyRoot, 'chrome_Default', 'chat-1');
    await put(path.join(legacyFresh, 'Default', 'Cookies'));

    await removeLeftoverBrowserProfileCopies([project]);
    await removeOldBrowserProfileCopies(project, { force: true, keep: [] });

    expect(existsSync(others)).toBe(true);
    expect(existsSync(settingUp)).toBe(true);
    expect(existsSync(legacyFresh)).toBe(true);

    // Once its owner is gone, it goes
    await put(path.join(others, OWNER_FILE), JSON.stringify({ pid: DEAD_PID, host: hostname() }));
    await removeOldBrowserProfileCopies(project, { force: true, keep: [] });
    expect(existsSync(others)).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('on Linux, tells an owner from a process that took its id after a reboot', async () => {
    const project = path.join(root, 'project');
    const copy = path.join(browserProfileCopiesRoot(project), 'firefox_y', 'chat-1');
    await put(path.join(copy, 'cookies.sqlite'));
    // The parent process's id, but another boot: a process that took the id of a Workbench gone since
    await put(path.join(copy, OWNER_FILE), JSON.stringify({ pid: process.ppid, host: hostname(), boot: 'another-boot', start: '1' }));

    await removeOldBrowserProfileCopies(project, { force: true, keep: [] });

    expect(existsSync(copy)).toBe(false);
  });

  it('removes the copies of runs still going on quit', async () => {
    const profile = path.join(root, 'firefox', 'x');
    await put(path.join(profile, 'cookies.sqlite'));
    const choice: PlaywrightBrowserChoice = {
      id: 'firefox:x', browser: 'firefox', engine: 'firefox', profileName: 'x',
      executablePath: '/usr/lib/firefox/firefox', userDataDir: path.join(root, 'firefox'), profilePath: profile,
    };
    const copy = (await prepareBrowserProfileCopy(path.join(root, 'project'), choice, 'chat-1'))!;
    expect(existsSync(copy)).toBe(true);

    await removeLiveBrowserProfileCopies();

    expect(existsSync(copy)).toBe(false);
  });

  it("still copies where the filesystem can't hold modes (chmod fails)", async () => {
    const profile = path.join(root, 'firefox', 'x');
    await put(path.join(profile, 'cookies.sqlite'), 'jar');
    const choice: PlaywrightBrowserChoice = {
      id: 'firefox:x', browser: 'firefox', engine: 'firefox', profileName: 'x',
      executablePath: '/usr/lib/firefox/firefox', userDataDir: path.join(root, 'firefox'), profilePath: profile,
    };
    vi.mocked(fsPromises.chmod).mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }));
    try {
      const copy = await prepareBrowserProfileCopy(path.join(root, 'project'), choice, 'chat-1');
      expect(await readFile(path.join(copy!, 'cookies.sqlite'), 'utf-8')).toBe('jar');
      // Other errors still fail the copy
      vi.mocked(fsPromises.chmod).mockRejectedValue(Object.assign(new Error('io'), { code: 'EIO' }));
      await expect(prepareBrowserProfileCopy(path.join(root, 'project'), choice, 'chat-2')).rejects.toThrow('io');
    } finally {
      vi.mocked(fsPromises.chmod).mockReset();
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      vi.mocked(fsPromises.chmod).mockImplementation(actual.chmod);
    }
  });

  it.skipIf(process.platform !== 'linux')('puts confined snap Chromium copies in the snap\'s own folder, private, and sweeps them', async () => {
    const userData = path.join(root, 'home', 'snap', 'chromium', 'common', 'chromium');
    const profile = path.join(userData, 'Default');
    await put(path.join(userData, 'Local State'), '{}');
    await put(path.join(profile, 'Cookies'), 'cookies');
    const choice: PlaywrightBrowserChoice = {
      id: 'chromium-snap:Default', browser: 'chromium', engine: 'chromium', profileName: 'Me',
      executablePath: '/snap/bin/chromium', userDataDir: userData, profileDirectory: 'Default', profilePath: profile,
    };
    const project = path.join(root, 'project');
    const snapBase = path.join(root, 'home', 'snap', 'chromium', 'common', 'workbench-profiles');

    const copy = (await prepareBrowserProfileCopy(project, choice, 'chat-1'))!;

    // Not under a hidden folder, which the snap's home interface denies
    expect(copy.startsWith(snapBase + path.sep)).toBe(true);
    expect(copy).toBe(path.join(browserProfileCopiesRoot(project, choice), 'chromium-snap_Default', 'chat-1'));
    expect(await readFile(path.join(copy, 'Default', 'Cookies'), 'utf-8')).toBe('cookies');
    const projectRoot = browserProfileCopiesRoot(project, choice);
    for (const dir of [snapBase, projectRoot, path.dirname(copy), copy]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    // Snap Firefox runs its own binary outside the sandbox: its copies stay in the app's folder
    const firefox = { ...choice, id: 'firefox-snap:x', engine: 'firefox' as const, executablePath: '/snap/bin/firefox' };
    expect(browserProfileCopiesRoot(project, firefox)).toBe(browserProfileCopiesRoot(project));

    // Another choice sweeps the snap's copies too
    await removeBrowserProfileCopy(copy);
    await leftover(copy, 'Default/Cookies');
    await removeOldBrowserProfileCopies(project, { force: true, keep: [] });
    expect(existsSync(copy)).toBe(false);

    // And so does startup
    await leftover(copy, 'Default/Cookies');
    await removeLeftoverBrowserProfileCopies([]);
    expect(existsSync(copy)).toBe(false);
  });

  it("on Windows, sweeps the copies a WSL session left in a running distribution's home", async () => {
    mocks.windows = true;
    mocks.wslDistros = ['Ubuntu', 'Debian'];
    mocks.wslRunning = 'Ubuntu\r\n';
    const inDistro = (distro: string, ...parts: string[]) => path.join(mocks.wslRoot, distro, ...parts);
    const crashed = inDistro('Ubuntu', 'home', 'me', '.cache', 'workbench', 'browser-profiles', 'project-0123456789abcdef', 'chrome_Default', 'chat-1');
    await leftover(crashed, 'Default/Cookies');
    const snapCrashed = inDistro('Ubuntu', 'home', 'me', 'snap', 'chromium', 'common', 'workbench-profiles', 'project-0123456789abcdef', 'chromium-snap_Default', 'chat-2');
    await leftover(snapCrashed, 'Default/Cookies');
    // Owned by a Workbench that still runs (in WSL mode, it is a Windows process too)
    const owned = inDistro('Ubuntu', 'home', 'me', '.cache', 'workbench', 'browser-profiles', 'project-0123456789abcdef', 'chrome_Default', 'chat-3');
    await put(path.join(owned, 'Default', 'Cookies'));
    await put(path.join(owned, OWNER_FILE), JSON.stringify({ pid: process.ppid, host: hostname() }));
    // A stopped distribution isn't started to look
    const stopped = inDistro('Debian', 'home', 'me', '.cache', 'workbench', 'browser-profiles', 'project-0123456789abcdef', 'chrome_Default', 'chat-1');
    await leftover(stopped, 'Default/Cookies');

    await removeLeftoverBrowserProfileCopies([]);

    expect(existsSync(crashed)).toBe(false);
    expect(existsSync(snapCrashed)).toBe(false);
    expect(existsSync(owned)).toBe(true);
    expect(existsSync(stopped)).toBe(true);
  });

  it("refreshes its owner files while copies are in use; an owner that stopped refreshing is gone", async () => {
    const profile = path.join(root, 'firefox', 'x');
    await put(path.join(profile, 'cookies.sqlite'));
    const choice: PlaywrightBrowserChoice = {
      id: 'firefox:x', browser: 'firefox', engine: 'firefox', profileName: 'x',
      executablePath: '/usr/lib/firefox/firefox', userDataDir: path.join(root, 'firefox'), profilePath: profile,
    };
    const project = path.join(root, 'project');
    // Earlier tests' copies end, and with them the heartbeat on real timers
    await removeLiveBrowserProfileCopies();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const copy = (await prepareBrowserProfileCopy(project, choice, 'chat-1'))!;
    const owner = path.join(copy, OWNER_FILE);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(owner, twoHoursAgo, twoHoursAgo);
    vi.advanceTimersByTime(10 * 60 * 1000);
    await vi.waitFor(async () => expect(Date.now() - (await stat(owner)).mtimeMs).toBeLessThan(60_000));
    await removeLiveBrowserProfileCopies();

    // A live process whose identity can't be checked (no boot and start, as off Linux): its claim lasts while refreshed
    const other = path.join(browserProfileCopiesRoot(project), 'firefox_y', 'chat-2');
    await put(path.join(other, 'cookies.sqlite'));
    await put(path.join(other, OWNER_FILE), JSON.stringify({ pid: process.ppid, host: hostname() }));
    await removeOldBrowserProfileCopies(project, { force: true, keep: [] });
    expect(existsSync(other)).toBe(true);
    await utimes(path.join(other, OWNER_FILE), twoHoursAgo, twoHoursAgo);
    await removeOldBrowserProfileCopies(project, { force: true, keep: [] });
    expect(existsSync(other)).toBe(false);
  });

  it("makes no copy for Playwright's own download", async () => {
    const choice: PlaywrightBrowserChoice = {
      id: 'playwright:firefox', browser: 'firefox', engine: 'firefox', managed: true, profileName: 'Firefox',
      executablePath: '/c/firefox', userDataDir: '', profilePath: '',
    };
    expect(await prepareBrowserProfileCopy(path.join(root, 'project'), choice, 'chat')).toBeNull();
    expect(existsSync(path.join(root, 'project'))).toBe(false);
  });

  it('gives no copy when the profile is gone', async () => {
    const choice: PlaywrightBrowserChoice = {
      id: 'chrome:Default',
      browser: 'chrome',
      engine: 'chromium',
      profileName: 'Me',
      executablePath: '/opt/google/chrome/chrome',
      userDataDir: path.join(root, 'missing'),
      profileDirectory: 'Default',
      profilePath: path.join(root, 'missing', 'Default'),
    };
    expect(await prepareBrowserProfileCopy(path.join(root, 'project'), choice, 'chat')).toBeNull();
  });
  describe('saved copies', () => {
    const firefox = (id = 'firefox:x.default'): PlaywrightBrowserChoice => ({
      id, browser: 'firefox', engine: 'firefox', profileName: 'default', executablePath: '/usr/lib/firefox/firefox',
      userDataDir: path.join(root, 'firefox'), profilePath: path.join(root, 'firefox', id.split(':')[1]),
    });
    const savedRoot = () => path.join(mocks.userData, 'browser-profiles', '_saved');

    it('saves a closed browser\'s profile and copies the saved one while the browser is open', async () => {
      const choice = firefox();
      await put(path.join(choice.profilePath, 'cookies.sqlite'), 'signed in');
      const project = path.join(root, 'project');
      mocks.inUse = false;

      // Closed: the run copies the live profile, and a saved copy is made meanwhile
      const first = await prepareBrowserProfileCopy(project, choice, 'chat-a');
      expect(await readFile(path.join(first!, 'cookies.sqlite'), 'utf-8')).toBe('signed in');
      await refreshSavedBrowserProfileCopy(choice);
      expect(await browserProfileCopyBlocked(choice)).toBe(false);

      // Open: the live profile changes under the browser, the run gets the saved copy
      mocks.inUse = true;
      await put(path.join(choice.profilePath, 'cookies.sqlite'), 'half written');
      expect(await browserProfileCopyBlocked(choice)).toBe(false);
      const second = await prepareBrowserProfileCopy(project, choice, 'chat-b');
      expect(await readFile(path.join(second!, 'cookies.sqlite'), 'utf-8')).toBe('signed in');
      expect(existsSync(path.join(second!, '.workbench-saved-complete'))).toBe(false);
      expect(JSON.parse(await readFile(path.join(second!, OWNER_FILE), 'utf-8'))).toMatchObject({ pid: process.pid });
    });

    it('blocks runs only while the browser is open with no saved copy', async () => {
      const choice = firefox();
      await put(path.join(choice.profilePath, 'cookies.sqlite'));
      expect(await browserProfileCopyBlocked(choice)).toBe(true);
      expect(existsSync(savedRoot())).toBe(false);
      expect(await browserProfileCopyBlocked({ ...choice, managed: true })).toBe(false);
    });

    it("keeps saved copies at startup, and removes them when another profile is chosen", async () => {
      const choice = firefox();
      await put(path.join(choice.profilePath, 'cookies.sqlite'));
      const project = path.join(root, 'project');
      mocks.inUse = false;
      await refreshSavedBrowserProfileCopy(choice);
      const saved = path.join(savedRoot(), 'firefox_x_default');
      expect(existsSync(saved)).toBe(true);

      await removeLeftoverBrowserProfileCopies([project]);
      expect(existsSync(saved)).toBe(true);

      await removeOldBrowserProfileCopies(project, { force: true, keep: [firefox('firefox:y.default')] });
      expect(existsSync(saved)).toBe(false);
    });

    it('keeps the copies of every profile still chosen when a run uses another one', async () => {
      const settingsChoice = firefox();
      const taskChoice = firefox('firefox:y.default');
      const dropped = firefox('firefox:z.default');
      for (const choice of [settingsChoice, taskChoice, dropped]) await put(path.join(choice.profilePath, 'cookies.sqlite'));
      const project = path.join(root, 'project');
      mocks.inUse = false;
      for (const choice of [settingsChoice, taskChoice, dropped]) await refreshSavedBrowserProfileCopy(choice);
      const copies = browserProfileCopiesRoot(project);
      const settingsCopy = path.join(copies, 'firefox_x_default', 'chat-old');
      const droppedCopy = path.join(copies, 'firefox_z_default', 'task-002-b-1234');
      await leftover(settingsCopy, 'cookies.sqlite');
      await leftover(droppedCopy, 'cookies.sqlite');

      // A task's run on its own profile, while Settings still chooses another one
      const run = (await prepareBrowserProfileCopy(project, taskChoice, 'task-001-a-1234', { project: [settingsChoice], all: [settingsChoice] }))!;
      await vi.waitFor(() => expect(existsSync(droppedCopy)).toBe(false));
      await vi.waitFor(() => expect(existsSync(path.join(savedRoot(), 'firefox_z_default'))).toBe(false));
      expect(existsSync(settingsCopy)).toBe(true);
      expect(existsSync(path.join(savedRoot(), 'firefox_x_default'))).toBe(true);
      expect(existsSync(path.join(savedRoot(), 'firefox_y_default'))).toBe(true);

      // Playwright's own browser for a run: profiles chosen elsewhere keep their copies
      await removeOldBrowserProfileCopies(project, { force: true, keep: [settingsChoice], keepSaved: [settingsChoice, taskChoice] });
      expect(existsSync(settingsCopy)).toBe(true);
      expect(existsSync(path.join(savedRoot(), 'firefox_y_default'))).toBe(true);
      await removeBrowserProfileCopy(run);
    });
  });
});
