import os from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));
vi.mock('../../platform/shell-runtime', () => ({ toHostPath: (p: string) => p }));

import { browserProfileCopyDir, prepareBrowserProfileCopy, removeBrowserProfileCopy } from '../profile-copy';

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
