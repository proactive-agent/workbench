import { describe, it, expect } from 'vitest';
import { registerChatBrowserWorkspace, getChatBrowserWorkspaces, sessionProjectId } from '../project-match';

const projects = [
  { id: 'app', path: '/work/app' },
  { id: 'inner', path: '/work/app/packages/inner' },
  { id: 'other', path: '/work/other' },
];

describe('session -> project', () => {
  it("leaves task runs' browsers out: they stay headless and unseen", () => {
    expect(sessionProjectId('/work/app/.workbench/worktrees/tasks/001-login', projects, new Map())).toBeUndefined();
    expect(sessionProjectId('/work/app', projects, new Map())).toBeUndefined();
    expect(sessionProjectId('/work/app/packages/inner/.workbench/worktrees/tasks/003', projects, new Map())).toBeUndefined();
  });

  it('leaves other folders out', () => {
    expect(sessionProjectId('/tmp/somewhere', projects, new Map())).toBeUndefined();
    expect(sessionProjectId(undefined, projects, new Map())).toBeUndefined();
  });

  it("matches a chat browser's folder while it is registered", () => {
    const unregister = registerChatBrowserWorkspace('/tmp/workbench-insights-abc/playwright', '/work/other');
    expect(sessionProjectId('/tmp/workbench-insights-abc/playwright', projects, getChatBrowserWorkspaces())).toBe('other');
    expect(sessionProjectId('/tmp/workbench-insights-abc/playwright/', projects, getChatBrowserWorkspaces())).toBe('other');
    unregister();
    expect(sessionProjectId('/tmp/workbench-insights-abc/playwright', projects, getChatBrowserWorkspaces())).toBeUndefined();
    // Its project, not one inside or around it
    const nested = new Map([['/tmp/chat-x', '/work/app/packages/inner']]);
    expect(sessionProjectId('/tmp/chat-x', projects, nested)).toBe('inner');
  });

  it("matches a WSL distribution's folders by either of Windows' names for them", () => {
    const wsl = [{ id: 'linux', path: '\\\\wsl$\\Ubuntu\\home\\me\\app' }];
    const chats = new Map([['\\\\wsl.localhost\\Ubuntu\\home\\me\\.cache\\workbench\\tmp\\chat-1', '\\\\wsl.localhost\\Ubuntu\\home\\me\\app']]);
    expect(sessionProjectId('\\\\wsl$\\Ubuntu\\home\\me\\.cache\\workbench\\tmp\\chat-1', wsl, chats, true)).toBe('linux');
  });

  it('ignores case on Windows and macOS', () => {
    const windows = [{ id: 'win', path: 'C:\\Users\\Me\\App' }];
    const chats = new Map([['C:\\Temp\\Chat-1', 'C:\\Users\\Me\\App']]);
    expect(sessionProjectId('c:\\temp\\chat-1', windows, chats, true)).toBe('win');
    expect(sessionProjectId('c:\\temp\\chat-1', windows, chats, false)).toBeUndefined();
  });
});
