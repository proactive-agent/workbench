/**
 * waitForManagedBrowser: a later download of the same browser shares the running watch and moves
 * its deadline, so a download that finishes after the first click's 15 minutes still updates the list
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ downloaded: new Set<string>() }));

vi.mock('../managed', () => ({
  findManagedBrowser: vi.fn(async (browser: string) => (mocks.downloaded.has(browser) ? `/home/me/.cache/ms-playwright/${browser}` : undefined)),
  scanManagedBrowsers: vi.fn(async () => []),
}));
vi.mock('../../mcp-commands', () => ({ resolveCommand: async () => null }));
vi.mock('../../platform/runtime-exec', () => ({ runTool: vi.fn() }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));
vi.mock('../../platform', () => ({ isWindows: () => false, isMacOS: () => false }));
vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => undefined,
  getWslInfo: () => null,
  toHostPath: (p: string) => p,
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  // No real browser profiles are scanned
  const homedir = () => '/nonexistent-home-for-test';
  return { ...actual, default: { ...actual, homedir }, homedir };
});

import { waitForManagedBrowser } from '../detect';

afterEach(() => {
  vi.useRealTimers();
  mocks.downloaded.clear();
});

describe('waitForManagedBrowser', () => {
  it("extends the shared watch's deadline on each call", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = waitForManagedBrowser('firefox');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const second = waitForManagedBrowser('firefox');
    expect(second).toBe(first);
    // Past the first call's deadline, before the second's
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    mocks.downloaded.add('firefox');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).not.toBeNull();
  });

  it('watches each browser on its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const firefox = waitForManagedBrowser('firefox');
    const webkit = waitForManagedBrowser('webkit');
    expect(webkit).not.toBe(firefox);
    mocks.downloaded.add('webkit');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await webkit).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 5_000);
    expect(await firefox).toBeNull();
  });

  it('gives up 15 minutes after the latest call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const watch = waitForManagedBrowser('firefox');
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 5_000);
    expect(await watch).toBeNull();
  });
});
