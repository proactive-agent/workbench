import { describe, it, expect } from 'vitest';
import { registerChatBrowserWorkspace, getChatBrowserWorkspaces, sessionProjectId } from '../project-match';

const projects = [
  { id: 'app', path: '/work/app' },
  { id: 'inner', path: '/work/app/packages/inner' },
  { id: 'other', path: '/work/other' },
];

describe('session -> project', () => {
  it('matches task worktrees and the project folder', () => {
    expect(sessionProjectId('/work/app/.workbench/worktrees/tasks/001-login', projects, new Map())).toBe('app');
    expect(sessionProjectId('/work/app', projects, new Map())).toBe('app');
    expect(sessionProjectId('/work/app/', projects, new Map())).toBe('app');
    expect(sessionProjectId('/work/other/.workbench/worktrees/tasks/002', projects, new Map())).toBe('other');
  });

  it('picks the innermost project', () => {
    expect(sessionProjectId('/work/app/packages/inner/.workbench/worktrees/tasks/003', projects, new Map())).toBe('inner');
  });

  it('leaves other folders out', () => {
    expect(sessionProjectId('/work/application', projects, new Map())).toBeUndefined();
    expect(sessionProjectId('/tmp/somewhere', projects, new Map())).toBeUndefined();
    expect(sessionProjectId(undefined, projects, new Map())).toBeUndefined();
  });

  it("matches a chat turn's folder while it is registered", () => {
    const unregister = registerChatBrowserWorkspace('/tmp/workbench-insights-abc/playwright', '/work/other');
    expect(sessionProjectId('/tmp/workbench-insights-abc/playwright', projects, getChatBrowserWorkspaces())).toBe('other');
    unregister();
    expect(sessionProjectId('/tmp/workbench-insights-abc/playwright', projects, getChatBrowserWorkspaces())).toBeUndefined();
  });

  it('ignores case on Windows and macOS', () => {
    const windows = [{ id: 'win', path: 'C:\\Users\\Me\\App' }];
    expect(sessionProjectId('c:\\users\\me\\app\\.workbench\\worktrees\\tasks\\001', windows, new Map(), true)).toBe('win');
    expect(sessionProjectId('c:\\users\\me\\app\\.workbench\\worktrees\\tasks\\001', windows, new Map(), false)).toBeUndefined();
  });
});
