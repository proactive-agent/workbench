import { describe, it, expect } from 'vitest';
import { bridgeSessions, isDrawerInput, toDrawerSessions, viewportDimension } from '../browser-drawer-service';
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
