import os from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { hostname } from 'os';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), chmod: vi.fn(actual.chmod) };
});
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));
const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }));
vi.mock('../../platform/shell-runtime', () => ({
  toHostPath: (p: string) => p,
  getWslInfo: () => null,
  whenShellRuntimeReady: async () => ({}),
}));

import {
  browserProfileCopiesRoot,
  browserProfileCopyDir,
  prepareBrowserProfileCopy,
  removeBrowserProfileCopy,
  removeLeftoverBrowserProfileCopies,
  removeLiveBrowserProfileCopies,
  removeOldBrowserProfileCopies,
  removeStaleBrowserProfileCopies,
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
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'profile-copy-'));
    mocks.userData = path.join(root, 'userData');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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
    const choice: PuppeteerBrowserChoice = {
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
    const choice: PuppeteerBrowserChoice = {
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

  it("removes a task's older copies, keeping the current run's and other tasks'", async () => {
    const profile = path.join(root, 'chrome', 'Default');
    await put(path.join(profile, 'Cookies'));
    const choice: PuppeteerBrowserChoice = {
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
    const choice: PuppeteerBrowserChoice = {
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
    const choice: PuppeteerBrowserChoice = {
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
    const choice: PuppeteerBrowserChoice = {
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
    const choice: PuppeteerBrowserChoice = {
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

    await removeOldBrowserProfileCopies(project, { force: true, current: choice });

    expect(existsSync(otherProfile)).toBe(false);
    expect(existsSync(oldSame)).toBe(false);
    expect(existsSync(recentSame)).toBe(true);
    expect(existsSync(live)).toBe(true);
    await removeBrowserProfileCopy(live);
  });

  it("removes a project's copies when runs use Puppeteer's own browser", async () => {
    const project = path.join(root, 'project');
    const recent = path.join(browserProfileCopiesRoot(project), 'chrome_Default', 'chat-1');
    await leftover(recent, 'Default/Cookies');
    const managed: PuppeteerBrowserChoice = {
      id: 'puppeteer:firefox', browser: 'firefox', engine: 'firefox', managed: true, profileName: 'Firefox',
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
    await removeOldBrowserProfileCopies(project, { force: true, current: null });

    expect(existsSync(others)).toBe(true);
    expect(existsSync(settingUp)).toBe(true);
    expect(existsSync(legacyFresh)).toBe(true);

    // Once its owner is gone, it goes
    await put(path.join(others, OWNER_FILE), JSON.stringify({ pid: DEAD_PID, host: hostname() }));
    await removeOldBrowserProfileCopies(project, { force: true, current: null });
    expect(existsSync(others)).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('on Linux, tells an owner from a process that took its id after a reboot', async () => {
    const project = path.join(root, 'project');
    const copy = path.join(browserProfileCopiesRoot(project), 'firefox_y', 'chat-1');
    await put(path.join(copy, 'cookies.sqlite'));
    // The parent process's id, but another boot: a process that took the id of a Workbench gone since
    await put(path.join(copy, OWNER_FILE), JSON.stringify({ pid: process.ppid, host: hostname(), boot: 'another-boot', start: '1' }));

    await removeOldBrowserProfileCopies(project, { force: true, current: null });

    expect(existsSync(copy)).toBe(false);
  });

  it('removes the copies of runs still going on quit', async () => {
    const profile = path.join(root, 'firefox', 'x');
    await put(path.join(profile, 'cookies.sqlite'));
    const choice: PuppeteerBrowserChoice = {
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
    const choice: PuppeteerBrowserChoice = {
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

  it("makes no copy for Puppeteer's own download", async () => {
    const choice: PuppeteerBrowserChoice = {
      id: 'puppeteer:firefox', browser: 'firefox', engine: 'firefox', managed: true, profileName: 'Firefox',
      executablePath: '/c/firefox', userDataDir: '', profilePath: '',
    };
    expect(await prepareBrowserProfileCopy(path.join(root, 'project'), choice, 'chat')).toBeNull();
    expect(existsSync(path.join(root, 'project'))).toBe(false);
  });

  it('gives no copy when the profile is gone', async () => {
    const choice: PuppeteerBrowserChoice = {
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
});
