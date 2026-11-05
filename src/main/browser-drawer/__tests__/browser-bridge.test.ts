import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { BrowserBridgeProcess, type BridgeMessage } from '../bridge-process';

/**
 * A stand-in for a browser's playwright-core, loaded by the real bridge script: one page whose
 * screencast sends three frames at once (a browser has several on their way) and whose mouse
 * moves are slow (a busy page), its calls written to calls.log
 */
const FAKE_PLAYWRIGHT = `
const fs = require('fs');
const path = require('path');
const log = (entry) => fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(entry) + '\\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let viewport = { width: 800, height: 600 };
const page = {
  on() {},
  url: () => 'about:blank',
  title: async () => 'Blank',
  mainFrame: () => null,
  emulateMedia: async () => {},
  viewportSize: () => viewport,
  setViewportSize: async (size) => { viewport = size; },
  screencast: {
    start: async ({ onFrame }) => {
      setTimeout(() => {
        for (const n of [1, 2, 3]) {
          Promise.resolve(onFrame({ data: new Uint8Array([n]), viewportWidth: 0, viewportHeight: 0 })).then(() => log({ acked: n }));
        }
      }, 50);
    },
    stop: async () => {},
  },
  mouse: {
    move: async (x) => { log({ move: x }); await sleep(200); },
    down: async () => log({ down: true }),
    up: async () => {},
    wheel: async (dx, dy) => log({ wheel: dy }),
  },
  keyboard: { down: async () => {}, up: async () => {}, insertText: async () => {} },
  close: async () => {},
};
const context = { pages: () => [page], on() {}, newPage: async () => page };
module.exports = { chromium: { connect: async () => ({ contexts: () => [context], on() {}, close: async () => {} }) } };
`;

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('browser bridge script', () => {
  let dir: string | undefined;
  let bridge: BrowserBridgeProcess | undefined;

  afterEach(async () => {
    await bridge?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
    bridge = undefined;
    dir = undefined;
  });

  it('sends one frame at a time and merges mouse moves waiting behind a slow one', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-script-test-'));
    const lib = path.join(dir, 'fake-playwright.cjs');
    await writeFile(lib, FAKE_PLAYWRIGHT);
    const calls = async () =>
      (await readFile(path.join(dir!, 'calls.log'), 'utf-8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

    bridge = new BrowserBridgeProcess({ execPath: process.execPath });
    const frames: number[] = [];
    let pageId: string | undefined;
    bridge.on('message', (message: BridgeMessage) => {
      if (message.type === 'pages' && message.pages[0]) pageId = message.pages[0].id;
      if (message.type === 'frame') frames.push(message.data[0]);
    });
    await bridge.start();
    bridge.send({ type: 'sessions', sessions: [{ id: 's1', endpoint: 'fake', browserName: 'chromium', playwrightLib: lib }] });
    await until(() => !!pageId);

    bridge.send({ type: 'view', viewerId: 1, pageId: pageId!, width: 700, height: 500, scale: 1 });
    await until(() => frames.length === 1);
    // The next frame waits for the drawer: the second is replaced by the third meanwhile
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frames).toEqual([1]);
    expect(await calls()).toContainEqual({ acked: 2 });
    bridge.send({ type: 'frameAck', pageId: pageId! });
    await until(() => frames.length === 2);
    expect(frames).toEqual([1, 3]);

    // Moves sent while the first is slow are merged into the newest; the click follows it
    for (const x of [1, 2, 3, 4]) bridge.send({ type: 'input', pageId: pageId!, event: { kind: 'mousemove', x, y: 0 } });
    bridge.send({ type: 'input', pageId: pageId!, event: { kind: 'mousedown', x: 5, y: 0, button: 'left', clickCount: 1 } });
    await until(async () => (await calls()).some((call) => call.down));
    const mouse = (await calls()).filter((call) => 'move' in call || 'down' in call);
    expect(mouse).toEqual([{ move: 1 }, { move: 4 }, { move: 5 }, { down: true }]);
  });
});
