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
  // The main frame, whose focused element is an iframe (it has an old selection of its own), with
  // a busy frame that never answers and the focused iframe, which holds the selection
  mainFrame: () => ({
    evaluate: async () => ({ inFrame: true, text: 'Old selection' }),
    childFrames: () => [
      { frameElement: async () => ({ evaluate: () => new Promise(() => {}), dispose: async () => {} }) },
      {
        frameElement: async () => ({ evaluate: async () => true, dispose: async () => {} }),
        evaluate: async () => { log({ read: true }); return { inFrame: false, text: 'Selected text' }; },
        childFrames: () => [],
      },
    ],
  }),
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
  keyboard: { down: async (key) => log({ key }), up: async () => {}, insertText: async () => {} },
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

  it("reads a page's selected text in turn with its input, before the keys after it", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-script-test-'));
    const lib = path.join(dir, 'fake-playwright.cjs');
    await writeFile(lib, FAKE_PLAYWRIGHT);
    const calls = async () =>
      (await readFile(path.join(dir!, 'calls.log'), 'utf-8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

    bridge = new BrowserBridgeProcess({ execPath: process.execPath });
    let pageId: string | undefined;
    bridge.on('message', (message: BridgeMessage) => {
      if (message.type === 'pages' && message.pages[0]) pageId = message.pages[0].id;
    });
    await bridge.start();
    bridge.send({ type: 'sessions', sessions: [{ id: 's1', endpoint: 'fake', browserName: 'chromium', playwrightLib: lib }] });
    await until(() => !!pageId);

    // A slow move, the copy shortcut's request, then its key (a cut removes the text once it lands)
    bridge.send({ type: 'input', pageId: pageId!, event: { kind: 'mousemove', x: 1, y: 0 } });
    const text = bridge.selectedText(pageId!);
    bridge.send({ type: 'input', pageId: pageId!, event: { kind: 'keydown', key: 'x' } });
    expect(await text).toBe('Selected text');
    await until(async () => (await calls()).some((call) => call.key));
    expect((await calls()).filter((call) => 'move' in call || 'read' in call || 'key' in call)).toEqual([{ move: 1 }, { read: true }, { key: 'x' }]);

    // A page it doesn't know has nothing selected
    await expect(bridge.selectedText('nope')).resolves.toBe('');
  });

  it('reports a page loading from its navigation request until it loads, and stops it on request', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-script-test-'));
    const lib = path.join(dir, 'fake-playwright.cjs');
    // A page that emits its events: a navigation request of its main frame, then load
    await writeFile(lib, `
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const log = (entry) => fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(entry) + '\\n');
const page = new EventEmitter();
const mainFrame = {};
Object.assign(page, {
  url: () => 'https://example.com/',
  title: async () => 'Example',
  mainFrame: () => mainFrame,
  emulateMedia: async () => {},
  close: async () => {},
  context: () => ({ newCDPSession: async () => ({ send: async (method) => log({ cdp: method }), detach: async () => {} }) }),
});
const nav = { isNavigationRequest: () => true, frame: () => mainFrame };
const navB = { isNavigationRequest: () => true, frame: () => mainFrame };
fs.watch(__dirname, (event, file) => {
  if (file === 'emit-request') page.emit('request', nav);
  if (file === 'emit-request-b') page.emit('request', navB);
  if (file === 'emit-fail-a') page.emit('requestfailed', nav);
  if (file === 'emit-load') page.emit('load');
});
const context = { pages: () => [page], on() {} };
module.exports = { chromium: { connect: async () => ({ contexts: () => [context], on() {}, close: async () => {} }) } };
`);
    bridge = new BrowserBridgeProcess({ execPath: process.execPath });
    let latest: { id: string; loading?: boolean } | undefined;
    bridge.on('message', (message: BridgeMessage) => {
      if (message.type === 'pages' && message.pages[0]) latest = message.pages[0];
    });
    await bridge.start();
    bridge.send({ type: 'sessions', sessions: [{ id: 's1', endpoint: 'fake', browserName: 'chromium', playwrightLib: lib }] });
    await until(() => latest?.loading === false);

    await writeFile(path.join(dir, 'emit-request'), '');
    await until(() => latest?.loading === true);
    await writeFile(path.join(dir, 'emit-load'), '');
    await until(() => latest?.loading === false);

    // A navigation replaced by another fails (aborted) after the new one started: still loading
    await writeFile(path.join(dir, 'emit-request'), 'a');
    await until(() => latest?.loading === true);
    await writeFile(path.join(dir, 'emit-request-b'), '');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(path.join(dir, 'emit-fail-a'), '');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(latest?.loading).toBe(true);
    await writeFile(path.join(dir, 'emit-load'), 'b');
    await until(() => latest?.loading === false);

    // Stopped from the drawer: Chromium's own stop, and no longer loading
    await writeFile(path.join(dir, 'emit-request'), 'again');
    await until(() => latest?.loading === true);
    bridge.send({ type: 'navigate', pageId: latest!.id, action: 'stop' });
    await until(() => latest?.loading === false);
    expect(await readFile(path.join(dir, 'calls.log'), 'utf-8')).toContain('Page.stopLoading');
  });
});
