import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { BrowserBridgeProcess } from '../bridge-process';

describe('browser bridge process', () => {
  let dir: string | undefined;
  let bridge: BrowserBridgeProcess | undefined;
  let server: net.Server | undefined;

  afterEach(async () => {
    await bridge?.stop();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
    bridge = undefined;
    server = undefined;
    dir = undefined;
  });

  it('runs the real bridge over stdio: says which endpoints answer, and stops', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\workbench-bridge-test-${process.pid}` : path.join(dir, 'live.sock');
    server = net.createServer((connection) => connection.destroy());
    await new Promise<void>((resolve) => server!.listen(socket, resolve));

    // The bridge script Workbench ships, run by this Node
    bridge = new BrowserBridgeProcess({ execPath: process.execPath });
    await Promise.all([bridge.start(), bridge.start()]);
    expect(bridge.running).toBe(true);

    const dead = path.join(dir, 'closed.sock');
    const live = await bridge.probe([socket, dead]);
    expect(live).toEqual(new Set([socket]));

    const exited = new Promise((resolve) => bridge!.once('exit', resolve));
    await bridge.stop();
    expect(bridge.running).toBe(false);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    // Stopped (quitting): a probe doesn't start it again
    await expect(bridge.probe([socket])).resolves.toBeNull();
    expect(bridge.running).toBe(false);
    // Nothing to start: nothing to ask
    await expect(new BrowserBridgeProcess({ execPath: path.join(dir, 'no-such-node') }).probe([socket])).resolves.toBeNull();
  }, 20_000);
});
