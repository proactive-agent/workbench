import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';
import { BrowserDrawerService, bridgeSessions, frameScale, isDrawerInput, toDrawerSessions, viewportDimension } from '../browser-drawer-service';
import type { BrowserBridgeProcess } from '../bridge-process';
import type { WebContents } from 'electron';
import type { RegistryDescriptor } from '../registry';

const descriptors: RegistryDescriptor[] = [
  { guid: 'task', title: 'claude-code', browserName: 'chromium', workspaceDir: '/work/app/.workbench/worktrees/tasks/001', endpoint: '/s/task.sock', playwrightLib: '/npx/a/playwright-core' },
  { guid: 'chat', title: 'claude-code', browserName: 'firefox', workspaceDir: '/tmp/workbench-insights-x/playwright', endpoint: '/s/chat.sock', playwrightLib: '/npx/a/playwright-core' },
  { guid: 'elsewhere', title: 'playwright-cli', browserName: 'chromium', workspaceDir: '/home/me', endpoint: '/s/cli.sock', playwrightLib: '/npx/b/playwright-core' },
];

describe('browser drawer service', () => {
  it("gives chats' browsers their project, and no other session", () => {
    const sessions = toDrawerSessions(descriptors, [{ id: 'app', path: '/work/app' }], new Map([['/tmp/workbench-insights-x/playwright', '/work/app']]), false);
    expect(sessions).toEqual([
      { id: 'task', title: 'claude-code', browserName: 'chromium', workspaceDir: '/work/app/.workbench/worktrees/tasks/001' },
      { id: 'chat', title: 'claude-code', browserName: 'firefox', workspaceDir: '/tmp/workbench-insights-x/playwright', projectId: 'app' },
      { id: 'elsewhere', title: 'playwright-cli', browserName: 'chromium', workspaceDir: '/home/me' },
    ]);
    // The bridge connects to the chats' browsers only (never a task's or another tool's)
    expect(bridgeSessions(descriptors, sessions)).toEqual([
      { id: 'chat', endpoint: '/s/chat.sock', browserName: 'firefox', playwrightLib: '/npx/a/playwright-core' },
    ]);
  });

  it("shows a chat browser's tabs with the browser the chat chose, not what the registry suggests", () => {
    const chats = new Map([['/tmp/workbench-insights-x/playwright', '/work/app']]);
    const projects = [{ id: 'app', path: '/work/app' }];
    const tabsFor = (browser: PlaywrightBrowserChoice | null | undefined) =>
      toDrawerSessions(descriptors, projects, chats, false, () => ({ projectId: 'app', chatId: 'c1', ...(browser !== undefined ? { browser } : {}) }))[1];
    const edge = { id: 'windows-edge:Default', browser: 'edge', engine: 'chromium', profileName: 'Default', executablePath: 'C:\\edge.exe', userDataDir: 'C:\\ud', profilePath: 'C:\\ud\\Default' } as const;
    // A Windows Edge attached over CDP has no executable in its entry, which reads as Playwright's own
    expect(tabsFor(edge)).toMatchObject({ browserName: 'chromium', managed: false });
    // Playwright's own Chromium
    expect(tabsFor(null)).toMatchObject({ browserName: 'chromium', managed: true });
    // Still starting: the registry's word
    expect(tabsFor(undefined)).toMatchObject({ browserName: 'firefox' });
  });

  it('asks frames at the window\'s pixel density, 1 to 2', () => {
    expect(frameScale(2)).toBe(2);
    expect(frameScale(1.25)).toBe(1.25);
    expect(frameScale(3)).toBe(2);
    expect(frameScale(0.5)).toBe(1);
    expect(frameScale('2')).toBe(1);
    expect(frameScale(undefined)).toBe(1);
  });

  it('keeps viewport sizes within limits', () => {
    expect(viewportDimension(640.4)).toBe(640);
    expect(viewportDimension(99999)).toBe(4096);
    expect(viewportDimension(-1)).toBe(0);
    expect(viewportDimension('12')).toBe(0);
  });

  it('accepts only the input the bridge replays', () => {
    expect(isDrawerInput({ kind: 'mousedown', x: 1, y: 2, button: 'left', clickCount: 1 })).toBe(true);
    expect(isDrawerInput({ kind: 'mousedown', x: 1, y: 2, button: 'back', clickCount: 1 })).toBe(false);
    expect(isDrawerInput({ kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 40 })).toBe(true);
    expect(isDrawerInput({ kind: 'keydown', key: 'Enter' })).toBe(true);
    expect(isDrawerInput({ kind: 'keydown', key: '' })).toBe(false);
    expect(isDrawerInput({ kind: 'text', text: 'hello' })).toBe(true);
    expect(isDrawerInput({ kind: 'mousedown', x: 1, y: 2, button: 'middle', clickCount: 1 })).toBe(true);
    expect(isDrawerInput({ kind: 'evaluate', script: 'x' })).toBe(false);
    expect(isDrawerInput(null)).toBe(false);
  });
});

describe('browser drawer viewers', () => {
  /** A bridge that records what it is sent */
  function fakeBridge() {
    const sent: unknown[] = [];
    const bridge = Object.assign(new EventEmitter(), {
      running: true,
      start: async () => undefined,
      stop: async () => undefined,
      killNow: () => undefined,
      send: (request: unknown) => { sent.push(request); },
    });
    return { bridge: bridge as unknown as BrowserBridgeProcess, emitter: bridge, sent };
  }
  const sender = (id: number) => ({ id, once: () => undefined, isDestroyed: () => false }) as unknown as WebContents;
  const views = (sent: unknown[]) => sent.filter((r) => (r as { type: string }).type === 'view');

  it("sends the page a reopened drawer asked for before it subscribed", async () => {
    const { bridge, emitter, sent } = fakeBridge();
    const service = new BrowserDrawerService({ getProjects: () => [], bridge });
    emitter.emit('message', { type: 'pages', pages: [{ id: 's#1', sessionId: 's', title: '', url: 'about:blank' }], connected: ['s'] });
    const window = sender(7);

    // The page view asks first (child effects run before the drawer's)
    service.view(window, 's#1', 800, 600, 2);
    expect(views(sent)).toEqual([]);
    await service.subscribe(window);
    expect(views(sent)).toEqual([{ type: 'view', viewerId: 7, pageId: 's#1', width: 800, height: 600, scale: 2 }]);

    // Closed: nothing is replayed when it opens again without asking
    service.unsubscribe(7);
    sent.length = 0;
    await service.subscribe(window);
    expect(views(sent)).toEqual([]);
  });

  it("streams an extension's popup to a window beside its tab, as a second view", async () => {
    const { bridge, emitter, sent } = fakeBridge();
    const service = new BrowserDrawerService({ getProjects: () => [], bridge });
    emitter.emit('message', {
      type: 'pages',
      pages: [
        { id: 's#1', sessionId: 's', title: '', url: 'https://a.test/' },
        { id: 's#2', sessionId: 's', title: 'Ext', url: 'chrome-extension://x/popup.html', popup: { extensionId: 'x', openerId: 's#1', width: 300, height: 200 } },
      ],
      connected: ['s'],
    });
    const frames: unknown[] = [];
    const window = Object.assign(sender(7), { send: (_channel: string, frame: unknown) => frames.push(frame) }) as unknown as WebContents;
    await service.subscribe(window);
    service.view(window, 's#1', 800, 600, 1);
    service.view(window, 's#2', 300, 200, 1, true);
    expect(views(sent)).toEqual([
      { type: 'view', viewerId: 7, pageId: 's#1', width: 800, height: 600, scale: 1 },
      { type: 'view', viewerId: -7, pageId: 's#2', width: 300, height: 200, scale: 1 },
    ]);
    emitter.emit('message', { type: 'frame', pageId: 's#2', viewers: [-7], data: new Uint8Array([1]), width: 300, height: 200 });
    expect(frames).toEqual([{ pageId: 's#2', data: new Uint8Array([1]), width: 300, height: 200 }]);

    // Closed: both views end
    sent.length = 0;
    service.unsubscribe(7);
    expect(views(sent)).toEqual([
      { type: 'view', viewerId: 7, pageId: null, width: 0, height: 0 },
      { type: 'view', viewerId: -7, pageId: null, width: 0, height: 0 },
    ]);
  });

  it("clicks an extension's button only for a chat browser's tab", async () => {
    const { bridge, emitter } = fakeBridge();
    const asked: unknown[] = [];
    Object.assign(bridge, { extensionAction: async (...args: unknown[]) => { asked.push(args); return 's#3'; } });
    const service = new BrowserDrawerService({ getProjects: () => [], bridge });
    (service as unknown as { sessions: unknown[] }).sessions = [{ id: 's', title: 'Workbench chat 1', browserName: 'chromium', projectId: 'p', chatId: 'c' }];
    emitter.emit('message', {
      type: 'pages',
      pages: [
        { id: 's#1', sessionId: 's', title: '', url: 'https://a.test/' },
        { id: 's#2', sessionId: 's', title: '', url: 'chrome-extension://x/popup.html', popup: { extensionId: 'x', openerId: 's#1', width: 1, height: 1 } },
      ],
      connected: ['s'],
    });
    const id = 'a'.repeat(32);
    expect(await service.extensionAction('s#1', id, 'Ext')).toBe('s#3');
    expect(asked).toEqual([['s#1', id, 'Ext', undefined]]);
    await expect(service.extensionAction('s#2', id, 'Ext')).rejects.toThrow();
    await expect(service.extensionAction('s#1', 'not an id', 'Ext')).rejects.toThrow();
    // Firefox's ids too
    expect(await service.extensionAction('s#1', 'addon@darkreader.org', 'Dark Reader')).toBe('s#3');
    await expect(service.extensionAction('gone', id, 'Ext')).rejects.toThrow();
  });

  it("puts a page's selected text on the clipboard for the copy shortcut, and nothing without one", async () => {
    const { bridge, emitter } = fakeBridge();
    const selected = new Map([['s#1', 'Copied text'], ['s#2', '']]);
    Object.assign(bridge, { selectedText: async (pageId: string) => selected.get(pageId) ?? '' });
    const written: string[] = [];
    const service = new BrowserDrawerService({ getProjects: () => [], bridge, writeClipboard: (text) => written.push(text) });
    emitter.emit('message', {
      type: 'pages',
      pages: [{ id: 's#1', sessionId: 's', title: '', url: 'about:blank' }, { id: 's#2', sessionId: 's', title: '', url: 'about:blank' }],
      connected: ['s'],
    });

    expect(await service.copySelection('s#1')).toBe(true);
    expect(await service.copySelection('s#2')).toBe(false);
    expect(await service.copySelection('gone')).toBe(false);
    expect(written).toEqual(['Copied text']);
  });

  it("gives the bridge Workbench's theme when it starts and whenever it changes", async () => {
    const { bridge, sent } = fakeBridge();
    (bridge as unknown as { running: boolean }).running = false;
    const service = new BrowserDrawerService({ getProjects: () => [], bridge });
    const schemes = () => sent.filter((r) => (r as { type: string }).type === 'colorScheme');

    // Kept until the bridge runs (a drawer opened), then sent before the sessions
    service.setColorScheme('dark');
    expect(schemes()).toEqual([]);
    (bridge as unknown as { running: boolean }).running = true;
    await service.subscribe(sender(3));
    expect(sent[0]).toEqual({ type: 'colorScheme', scheme: 'dark' });

    // Changes are passed on once; repeats and anything else are dropped
    service.setColorScheme('dark');
    service.setColorScheme('light');
    service.setColorScheme('sepia');
    expect(schemes()).toEqual([{ type: 'colorScheme', scheme: 'dark' }, { type: 'colorScheme', scheme: 'light' }]);
  });

  it('sends the cursor a page asks for to the windows viewing it, popups included', async () => {
    const { bridge, emitter } = fakeBridge();
    const service = new BrowserDrawerService({ getProjects: () => [], bridge });
    const sent: Array<[number, unknown]> = [];
    const window = (id: number) => ({ id, once: () => undefined, isDestroyed: () => false, send: (_channel: string, payload: unknown) => sent.push([id, payload]) }) as unknown as WebContents;
    await service.subscribe(window(3));
    await service.subscribe(window(4));
    // Window 3 views the page, window 4's popup view too (its id negated)
    emitter.emit('message', { type: 'cursor', pageId: 's#1', viewers: [3, -4], cursor: 'pointer' });
    expect(sent).toEqual([[3, { pageId: 's#1', cursor: 'pointer' }], [4, { pageId: 's#1', cursor: 'pointer' }]]);
  });
});
