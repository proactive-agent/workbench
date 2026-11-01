import os from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));
vi.mock('../../platform/shell-runtime', () => ({ toHostPath: (p: string) => p }));

import {
  browserProfileCopyDir,
  prepareBrowserProfileCopy,
  removeBrowserProfileCopy,
  removeOldBrowserProfileCopies,
  removeStaleBrowserProfileCopies,
} from '../profile-copy';

const isPosix = process.platform !== 'win32';

let root: string;

async function put(file: string, content = 'x'): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe('browser profile copies', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'profile-copy-'));
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

    expect(copy).toBe(path.join(project, '.workbench', 'browser-profiles', 'chrome_Profile_1', 'task-001-x'));
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
    await put(path.join(old, 'Default', 'Cookies'));
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
    // Made by an earlier version with the default mode
    await mkdir(path.join(project, '.workbench', 'browser-profiles'), { recursive: true, mode: 0o755 });

    const copy = (await prepareBrowserProfileCopy(project, choice, 'chat-1'))!;

    expect(existsSync(path.join(copy, 'Default', 'Cookies'))).toBe(true);
    for (const left of ['Sessions', 'Current Session', 'Last Tabs', 'Storage/ext/abc/def/Code Cache']) {
      expect(existsSync(path.join(copy, 'Default', left))).toBe(false);
    }
    const prefs = JSON.parse(await readFile(path.join(copy, 'Default', 'Preferences'), 'utf-8'));
    expect(prefs).toEqual({ session: { restore_on_startup: 5, startup_urls: [] }, other: 1 });
    if (isPosix) {
      for (const dir of [path.join(project, '.workbench', 'browser-profiles'), path.dirname(copy), copy, path.join(copy, 'Default')]) {
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
    const profile = path.join(root, 'chrome', 'Default');
    await put(path.join(profile, 'Cookies'));
    const choice: PuppeteerBrowserChoice = {
      id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Me',
      executablePath: '/opt/google/chrome/chrome', userDataDir: path.join(root, 'chrome'), profileDirectory: 'Default', profilePath: profile,
    };
    const project = path.join(root, 'project');
    const copies = path.join(project, '.workbench', 'browser-profiles');
    const dayAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const oldOther = path.join(copies, 'firefox_y', 'chat');
    const recent = path.join(copies, 'firefox_y', 'task-003-c-1234');
    await put(path.join(oldOther, 'cookies.sqlite'));
    await put(path.join(recent, 'cookies.sqlite'));
    await utimes(oldOther, dayAgo, dayAgo);
    const live = (await prepareBrowserProfileCopy(project, choice, 'task-004-d-5678'))!;
    await utimes(live, dayAgo, dayAgo);

    await removeOldBrowserProfileCopies(project, true);

    expect(existsSync(oldOther)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(live)).toBe(true);
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
