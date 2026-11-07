import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lutimes, mkdtemp, readFile, rm, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { hostname, tmpdir } from 'os';
import path from 'path';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';

const mocks = vi.hoisted(() => ({ windows: false, linux: false, mac: false }));

vi.mock('../../platform', () => ({ isWindows: () => mocks.windows, isLinux: () => mocks.linux, isMacOS: () => mocks.mac }));
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
    mocks.mac = false;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const firefox = (executablePath = '/usr/lib/firefox/firefox'): PlaywrightBrowserChoice => ({
    id: 'firefox:x', browser: 'firefox', engine: 'firefox', profileName: 'default',
    executablePath, userDataDir: path.dirname(dir), profilePath: dir,
  });
  const chrome = (): PlaywrightBrowserChoice => ({
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

  it.skipIf(process.platform !== 'linux')('on Linux, reads a lock written before the process started as open (clock steps move lock times)', async () => {
    mocks.linux = true;
    const name = (await readFile(`/proc/${process.pid}/comm`, 'utf-8')).trim();
    const link = path.join(dir, 'SingletonLock');
    await symlink(`${hostname()}-${process.pid}`, link);
    const choice = { ...chrome(), executablePath: `/opt/browser/${name}` };
    expect(await isBrowserProfileInUse(choice)).toBe(true);
    // As after the clock stepped back: the lock looks older than the browser holding it
    const before = new Date(Date.now() - process.uptime() * 1000 - 60 * 60 * 1000);
    await lutimes(link, before, before);
    expect(await isBrowserProfileInUse(choice)).toBe(true);
  });

  it.skipIf(!existsSync('/bin/ps') || isRoot)('on macOS, names the process with ps and counts it only when it is a browser', async () => {
    mocks.mac = true;
    await symlink(`127.0.1.1:+${process.pid}`, path.join(dir, 'lock'));
    // This test's process is node, not Firefox: a pid reused since the browser crashed
    expect(await isBrowserProfileInUse(firefox())).toBe(false);
    const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(process.pid), '-o', 'comm=']);
    const name = path.basename(stdout.trim()).slice(0, 15);
    expect(await isBrowserProfileInUse(firefox(`/opt/browser/${name}`))).toBe(true);
  });

  it("reads Chromium's SingletonLock in its user data folder; another host's only for a browser here", async () => {
    expect(await isBrowserProfileInUse(chrome())).toBe(false);
    await symlink(`other-host-${process.pid}`, path.join(dir, 'SingletonLock'));
    expect(await isBrowserProfileInUse(chrome())).toBe(false);
    await rm(path.join(dir, 'SingletonLock'));
    await symlink(`${hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'));
    expect(await isBrowserProfileInUse(chrome())).toBe(true);
  });

  describe.skipIf(process.platform !== 'linux' || !existsSync('/bin/sleep'))('on Linux, with processes named like browsers', { timeout: 20_000 }, () => {
    const children: ChildProcess[] = [];
    /** A process whose name (comm) is `name`: sleep started through a link with that name */
    async function processNamed(name: string): Promise<number> {
      const link = path.join(dir, name);
      await symlink('/bin/sleep', link);
      // Run as `sleep` (argv[0]) while the process is named after the link: Rust coreutils (Ubuntu
      // 25.10+) is one binary that picks its tool by argv[0], and exits at once as `chrome`
      const child = spawn(link, ['30'], { stdio: 'ignore', argv0: 'sleep' });
      children.push(child);
      // Until exec has replaced the forked node's name, failing here rather than in the assertion
      // that needs it
      for (let i = 0; i < 1000; i++) {
        const comm = await readFile(`/proc/${child.pid}/comm`, 'utf-8').catch(() => '');
        if (comm.trim() === name.slice(0, 15)) return child.pid!;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`process ${child.pid} never ran as ${name}`);
    }
    afterEach(() => {
      for (const child of children.splice(0)) child.kill();
    });

    it("counts only the lock's own engine: a Firefox lock taken over by a Chrome process reads as closed", async () => {
      mocks.linux = true;
      const chromePid = await processNamed('chrome');
      await symlink(`127.0.1.1:+${chromePid}`, path.join(dir, 'lock'));
      expect(await isBrowserProfileInUse(firefox('/usr/lib/firefox-esr/firefox-esr'))).toBe(false);
      await symlink(`${hostname()}-${chromePid}`, path.join(dir, 'SingletonLock'));
      expect(await isBrowserProfileInUse(chrome())).toBe(true);
      await rm(path.join(dir, 'lock'));
      const firefoxPid = await processNamed('firefox');
      await symlink(`127.0.1.1:+${firefoxPid}`, path.join(dir, 'lock'));
      expect(await isBrowserProfileInUse(firefox('/usr/lib/firefox-esr/firefox-esr'))).toBe(true);
    });

    it("never counts Chromium's crash handler", async () => {
      mocks.linux = true;
      const crashpad = await processNamed('chrome_crashpad_handler');
      await symlink(`127.0.1.1:+${crashpad}`, path.join(dir, 'lock'));
      expect(await isBrowserProfileInUse(firefox())).toBe(false);
      await symlink(`${hostname()}-${crashpad}`, path.join(dir, 'SingletonLock'));
      expect(await isBrowserProfileInUse(chrome())).toBe(false);
    });

    it('reads a lock naming another host as open while its pid is a Chromium browser here (the host was renamed)', async () => {
      mocks.linux = true;
      const chromePid = await processNamed('chrome');
      await symlink(`old-dhcp-name.local-${chromePid}`, path.join(dir, 'SingletonLock'));
      expect(await isBrowserProfileInUse(chrome())).toBe(true);
      await rm(path.join(dir, 'SingletonLock'));
      // Another host's lock whose pid is something else here, or nothing: closed
      await symlink(`old-dhcp-name.local-${process.pid}`, path.join(dir, 'SingletonLock'));
      expect(await isBrowserProfileInUse(chrome())).toBe(false);
      await rm(path.join(dir, 'SingletonLock'));
      await symlink(`old-dhcp-name.local-${DEAD_PID}`, path.join(dir, 'SingletonLock'));
      expect(await isBrowserProfileInUse(chrome())).toBe(false);
    });
  });

  it("never reads Playwright's own browsers as open", async () => {
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
    // In WSL mode its browsers are stored with their Linux paths
    expect(await isBrowserProfileInUse({ ...wsl, profilePath: '/home/me/.mozilla/firefox/x' })).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
    await isBrowserProfileInUse({ ...firefox(), profilePath: '\\\\server\\home\\me\\Firefox\\x' });
    expect(openMock).toHaveBeenCalledTimes(1);
  });
});
