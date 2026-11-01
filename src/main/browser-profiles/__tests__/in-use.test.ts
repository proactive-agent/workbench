import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, symlink } from 'fs/promises';
import { hostname, tmpdir } from 'os';
import path from 'path';
import type { PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

const mocks = vi.hoisted(() => ({ windows: false, linux: false }));

vi.mock('../../platform', () => ({ isWindows: () => mocks.windows, isLinux: () => mocks.linux }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

import { open } from 'fs/promises';
import { isBrowserProfileInUse } from '../in-use';

/** A process id nothing runs as */
const DEAD_PID = 2 ** 22 + 12345;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe.skipIf(process.platform === 'win32')('isBrowserProfileInUse', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'browser-lock-'));
    mocks.windows = false;
    mocks.linux = false;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const firefox = (executablePath = '/usr/lib/firefox/firefox'): PuppeteerBrowserChoice => ({
    id: 'firefox:x', browser: 'firefox', engine: 'firefox', profileName: 'default',
    executablePath, userDataDir: path.dirname(dir), profilePath: dir,
  });
  const chrome = (): PuppeteerBrowserChoice => ({
    id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Default', profileDirectory: 'Default',
    executablePath: '/opt/google/chrome/chrome', userDataDir: dir, profilePath: path.join(dir, 'Default'),
  });

  it('reads Firefox as open while the process its lock names runs', async () => {
    await symlink(`127.0.1.1:+${process.pid}`, path.join(dir, 'lock'));
    expect(await isBrowserProfileInUse(firefox())).toBe(true);
  });

  it("reads Firefox's NFS-style lock without the plus sign", async () => {
    await symlink(`127.0.1.1:${process.pid}`, path.join(dir, 'lock'));
    expect(await isBrowserProfileInUse(firefox())).toBe(true);
  });

  it('reads a lock a crashed browser left behind as closed', async () => {
    await symlink(`127.0.1.1:+${DEAD_PID}`, path.join(dir, 'lock'));
    expect(await isBrowserProfileInUse(firefox())).toBe(false);
  });

  it.skipIf(isRoot)("reads a lock whose process id now belongs to another user's process as closed", async () => {
    // pid 1 runs as root
    await symlink(`127.0.1.1:+1`, path.join(dir, 'lock'));
    expect(await isBrowserProfileInUse(firefox())).toBe(false);
    mocks.linux = process.platform === 'linux';
    expect(await isBrowserProfileInUse(firefox())).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('on Linux, counts the process only when it is a browser', async () => {
    mocks.linux = true;
    await symlink(`127.0.1.1:+${process.pid}`, path.join(dir, 'lock'));
    // This test's process is node, not Firefox: a pid reused since the browser crashed
    expect(await isBrowserProfileInUse(firefox())).toBe(false);
    const name = (await readFile(`/proc/${process.pid}/comm`, 'utf-8')).trim();
    expect(await isBrowserProfileInUse(firefox(`/opt/browser/${name}`))).toBe(true);
  });

  it("reads Chromium's SingletonLock in its user data folder, from this host only", async () => {
    expect(await isBrowserProfileInUse(chrome())).toBe(false);
    await symlink(`other-host-${process.pid}`, path.join(dir, 'SingletonLock'));
    expect(await isBrowserProfileInUse(chrome())).toBe(false);
    await rm(path.join(dir, 'SingletonLock'));
    await symlink(`${hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'));
    expect(await isBrowserProfileInUse(chrome())).toBe(true);
  });

  it("never reads Puppeteer's own browsers as open", async () => {
    await symlink(`127.0.1.1:+${process.pid}`, path.join(dir, 'lock'));
    expect(await isBrowserProfileInUse({ ...firefox(), managed: true })).toBe(false);
  });

  it('on Windows, checks profiles on network shares but not in WSL', async () => {
    mocks.windows = true;
    const openMock = vi.mocked(open);
    openMock.mockClear();
    const wsl = { ...firefox(), profilePath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.mozilla\\firefox\\x' };
    expect(await isBrowserProfileInUse(wsl)).toBe(false);
    expect(await isBrowserProfileInUse({ ...wsl, profilePath: '\\\\wsl$\\Ubuntu\\home\\me\\x' })).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
    await isBrowserProfileInUse({ ...firefox(), profilePath: '\\\\server\\home\\me\\Firefox\\x' });
    expect(openMock).toHaveBeenCalledTimes(1);
  });
});
