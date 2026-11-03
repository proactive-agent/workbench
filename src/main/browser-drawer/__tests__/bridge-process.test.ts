import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { BrowserBridgeProcess, type BridgeMessage } from '../bridge-process';

// A stand-in bridge: answers each request with what it got, frames as bytes
const FAKE_BRIDGE = `
process.on('message', (m) => {
  if (m.type === 'sessions') process.send({ type: 'pages', pages: m.sessions.map((s) => ({ id: s.id + '#1', sessionId: s.id, title: '', url: 'about:blank' })) });
  if (m.type === 'view') process.send({ type: 'frame', pageId: m.pageId, viewers: [m.viewerId], data: Buffer.from([1, 2, 3]), width: m.width, height: m.height });
});
process.on('disconnect', () => process.exit(0));
`;

describe('browser bridge process', () => {
  let dir: string;
  let bridge: BrowserBridgeProcess;

  afterEach(async () => {
    await bridge?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('starts once, exchanges messages with bytes and stops', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
    const script = path.join(dir, 'bridge.cjs');
    await writeFile(script, FAKE_BRIDGE);
    bridge = new BrowserBridgeProcess({ scriptPath: script, execPath: process.execPath });
    await Promise.all([bridge.start(), bridge.start()]);
    expect(bridge.running).toBe(true);

    const messages: BridgeMessage[] = [];
    const received = (count: number) => new Promise<void>((resolve) => {
      const check = () => (messages.length >= count ? resolve() : setTimeout(check, 10));
      check();
    });
    bridge.on('message', (message: BridgeMessage) => messages.push(message));
    bridge.send({ type: 'sessions', sessions: [{ id: 's', endpoint: '/x.sock', browserName: 'chromium', playwrightLib: '/pw' }] });
    bridge.send({ type: 'view', viewerId: 7, pageId: 's#1', width: 800, height: 600 });
    await received(2);
    expect(messages[0]).toEqual({ type: 'pages', pages: [{ id: 's#1', sessionId: 's', title: '', url: 'about:blank' }] });
    expect(messages[1]).toMatchObject({ type: 'frame', pageId: 's#1', viewers: [7], width: 800, height: 600 });
    expect([...(messages[1] as { data: Uint8Array }).data]).toEqual([1, 2, 3]);

    const exited = new Promise((resolve) => bridge.once('exit', resolve));
    await bridge.stop();
    expect(bridge.running).toBe(false);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 500))]);
  });
});
