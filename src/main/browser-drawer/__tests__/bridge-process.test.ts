import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { BrowserBridgeProcess } from '../bridge-process';

describe('browser bridge process', () => {
  let dir: string | undefined;
  let bridge: BrowserBridgeProcess | undefined;

  afterEach(async () => {
    await bridge?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
    bridge = undefined;
    dir = undefined;
  });

  it('runs the real bridge over stdio once, and stops it for good', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
    // The bridge script Workbench ships, run by this Node
    bridge = new BrowserBridgeProcess({ execPath: process.execPath });
    await Promise.all([bridge.start(), bridge.start()]);
    expect(bridge.running).toBe(true);

    const exited = new Promise((resolve) => bridge!.once('exit', resolve));
    await bridge.stop();
    expect(bridge.running).toBe(false);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    // Stopped (quitting): never started again
    await expect(bridge.start()).rejects.toThrow(/stopped/);
    expect(bridge.running).toBe(false);
  }, 20_000);
});
