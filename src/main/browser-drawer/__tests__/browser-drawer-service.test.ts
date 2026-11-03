import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { BrowserDrawerService, bridgeSessions, isDrawerInput, toDrawerSessions, viewportDimension } from '../browser-drawer-service';
import type { BrowserBridgeProcess } from '../bridge-process';
import type { WebContents } from 'electron';
import type { RegistryDescriptor } from '../registry';

const descriptors: RegistryDescriptor[] = [
  { guid: 'task', title: 'claude-code', browserName: 'chromium', workspaceDir: '/work/app/.workbench/worktrees/tasks/001', endpoint: '/s/task.sock', playwrightLib: '/npx/a/playwright-core' },
  { guid: 'chat', title: 'claude-code', browserName: 'firefox', workspaceDir: '/tmp/workbench-insights-x/playwright', endpoint: '/s/chat.sock', playwrightLib: '/npx/a/playwright-core' },
  { guid: 'elsewhere', title: 'playwright-cli', browserName: 'chromium', workspaceDir: '/home/me', endpoint: '/s/cli.sock', playwrightLib: '/npx/b/playwright-core' },
];

describe('browser drawer service', () => {
  it('gives each session its project', () => {
    const sessions = toDrawerSessions(descriptors, [{ id: 'app', path: '/work/app' }], new Map([['/tmp/workbench-insights-x/playwright', '/work/app']]), false);
    expect(sessions).toEqual([
      { id: 'task', title: 'claude-code', browserName: 'chromium', workspaceDir: '/work/app/.workbench/worktrees/tasks/001', projectId: 'app' },
      { id: 'chat', title: 'claude-code', browserName: 'firefox', workspaceDir: '/tmp/workbench-insights-x/playwright', projectId: 'app' },
      { id: 'elsewhere', title: 'playwright-cli', browserName: 'chromium', workspaceDir: '/home/me' },
    ]);
    // The bridge connects to the projects' browsers only
    expect(bridgeSessions(descriptors, sessions)).toEqual([
      { id: 'task', endpoint: '/s/task.sock', browserName: 'chromium', playwrightLib: '/npx/a/playwright-core' },
      { id: 'chat', endpoint: '/s/chat.sock', browserName: 'firefox', playwrightLib: '/npx/a/playwright-core' },
    ]);
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
    service.view(window, 's#1', 800, 600);
    expect(views(sent)).toEqual([]);
    await service.subscribe(window);
    expect(views(sent)).toEqual([{ type: 'view', viewerId: 7, pageId: 's#1', width: 800, height: 600 }]);

    // Closed: nothing is replayed when it opens again without asking
    service.unsubscribe(7);
    sent.length = 0;
    await service.subscribe(window);
    expect(views(sent)).toEqual([]);
  });
});
