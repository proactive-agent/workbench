import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

vi.mock('../../platform', () => ({ isWindows: () => false }));

import { isBrowserProfileInUse } from '../in-use';

/** A process id nothing runs as */
const DEAD_PID = 2 ** 22 + 12345;

describe.skipIf(process.platform === 'win32')('isBrowserProfileInUse', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'browser-lock-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const firefox = (): PuppeteerBrowserChoice => ({
    id: 'firefox:x', browser: 'firefox', engine: 'firefox', profileName: 'default',
    executablePath: '/usr/lib/firefox/firefox', userDataDir: path.dirname(dir), profilePath: dir,
  });
  const chrome = (): PuppeteerBrowserChoice => ({
    id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Default', profileDirectory: 'Default',
    executablePath: '/opt/google/chrome/chrome', userDataDir: dir, profilePath: path.join(dir, 'Default'),
  });

  it('reads Firefox as open while the process its lock names runs', async () => {
    await symlink(`127.0.1.1:+${process.pid}`, path.join(dir, 'lock'));
    expect(await isBrowserProfileInUse(firefox())).toBe(true);
  });

  it('reads a lock a crashed browser left behind as closed', async () => {
    await symlink(`127.0.1.1:+${DEAD_PID}`, path.join(dir, 'lock'));
    expect(await isBrowserProfileInUse(firefox())).toBe(false);
  });

  it("reads Chromium's SingletonLock in its user data folder", async () => {
    expect(await isBrowserProfileInUse(chrome())).toBe(false);
    await symlink(`my-host-${process.pid}`, path.join(dir, 'SingletonLock'));
    expect(await isBrowserProfileInUse(chrome())).toBe(true);
  });

  it("never reads Puppeteer's own browsers as open", async () => {
    await symlink(`127.0.1.1:+${process.pid}`, path.join(dir, 'lock'));
    expect(await isBrowserProfileInUse({ ...firefox(), managed: true })).toBe(false);
  });
});
