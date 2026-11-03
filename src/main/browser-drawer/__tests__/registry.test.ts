import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, utimes } from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { canConnect, parseDescriptor, readLiveSessions, registryDir } from '../registry';

const descriptor = (guid: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  playwrightVersion: '1.64.0-alpha-1790635538000',
  playwrightLib: '/home/me/.npm/_npx/abc/node_modules/playwright-core',
  title: 'claude-code',
  browser: { guid, browserName: 'chromium', launchOptions: {} },
  endpoint: `/tmp/pw-1/browser/${guid}.sock`,
  workspaceDir: '/work/project/.workbench/worktrees/tasks/001-x',
  ...extra,
});

describe('Playwright registry folder', () => {
  it('follows playwright-core per OS', () => {
    expect(registryDir('linux', {}, '/home/me')).toBe('/home/me/.cache/ms-playwright/b');
    expect(registryDir('linux', { XDG_CACHE_HOME: '/xdg' }, '/home/me')).toBe('/xdg/ms-playwright/b');
    expect(registryDir('macos', {}, '/Users/me')).toBe('/Users/me/Library/Caches/ms-playwright/b');
    expect(registryDir('windows', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me'))
      .toBe('C:\\Users\\me\\AppData\\Local\\ms-playwright\\b');
    expect(registryDir('windows', {}, 'C:\\Users\\me')).toBe('C:\\Users\\me\\AppData\\Local\\ms-playwright\\b');
    expect(registryDir('linux', { PWTEST_SERVER_REGISTRY: '/custom' }, '/home/me')).toBe('/custom');
  });
});

describe('registry descriptors', () => {
  it('reads a bound browser', () => {
    expect(parseDescriptor(descriptor('g1'))).toEqual({
      guid: 'g1',
      title: 'claude-code',
      browserName: 'chromium',
      workspaceDir: '/work/project/.workbench/worktrees/tasks/001-x',
      endpoint: '/tmp/pw-1/browser/g1.sock',
      playwrightVersion: '1.64.0-alpha-1790635538000',
      playwrightLib: '/home/me/.npm/_npx/abc/node_modules/playwright-core',
      managed: true,
    });
  });

  it("tells Playwright's own browsers from the user's", () => {
    const withExecutable = (executablePath: string) => {
      const raw = JSON.parse(descriptor('g1'));
      raw.browser.launchOptions = { executablePath };
      return parseDescriptor(JSON.stringify(raw))?.managed;
    };
    expect(withExecutable('/snap/firefox/current/usr/lib/firefox/firefox')).toBe(false);
    expect(withExecutable('/home/me/.cache/ms-playwright/chromium-1200/chrome-linux/chrome')).toBe(true);
    expect(withExecutable('C:\\Users\\me\\AppData\\Local\\ms-playwright\\firefox-1500\\firefox.exe')).toBe(true);
  });

  it('leaves out what is not one', () => {
    expect(parseDescriptor('{')).toBeNull();
    expect(parseDescriptor('null')).toBeNull();
    expect(parseDescriptor(JSON.stringify({ title: 'x' }))).toBeNull();
  });
});

describe('live sessions', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('lists the browsers whose socket answers, without internal ones', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pw-registry-'));
    await writeFile(path.join(dir, 'live'), descriptor('live'));
    await writeFile(path.join(dir, 'closed'), descriptor('closed'));
    await writeFile(path.join(dir, 'probe'), descriptor('probe', { title: '--playwright-internal-workbench-probe' }));
    await writeFile(path.join(dir, 'broken'), '{');
    const asked: string[] = [];
    const connect = async (endpoint: string) => {
      asked.push(endpoint);
      return endpoint.includes('/live.sock');
    };
    const dead = new Map<string, number>();
    const sessions = await readLiveSessions(dir, dead, connect);
    expect(sessions.map((s) => s.guid)).toEqual(['live']);
    expect(asked.sort()).toEqual(['/tmp/pw-1/browser/closed.sock', '/tmp/pw-1/browser/live.sock']);

    // A closed browser's file isn't read again until it changes
    asked.length = 0;
    await readLiveSessions(dir, dead, connect);
    expect(asked).toEqual(['/tmp/pw-1/browser/live.sock']);
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(dir, 'closed'), later, later);
    asked.length = 0;
    await readLiveSessions(dir, dead, connect);
    expect(asked.sort()).toEqual(['/tmp/pw-1/browser/closed.sock', '/tmp/pw-1/browser/live.sock']);
  });

  it('has none without a registry folder', async () => {
    expect(await readLiveSessions(path.join(os.tmpdir(), 'no-such-registry-folder'))).toEqual([]);
  });

  it('connects to a local socket', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pw-sock-'));
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\workbench-test-${process.pid}` : path.join(dir, 's.sock');
    const server = net.createServer((c) => c.destroy());
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(await canConnect(socket)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await canConnect(socket)).toBe(false);
  });
});
