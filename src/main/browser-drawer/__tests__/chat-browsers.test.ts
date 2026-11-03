import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { ChatBrowsers, holderArgs, holderError, type ChatBrowserHolder, type StartChatBrowserHolder } from '../chat-browsers';
import { toDrawerSessions } from '../browser-drawer-service';

/** A holder that starts when `start()` is called and records closes */
function fakeHolders() {
  const started: Array<{ title: string; choice: unknown; resolve: () => void; reject: (e: Error) => void; exit: () => void; closed: boolean }> = [];
  const start: StartChatBrowserHolder = ({ title, choice }) => new Promise<ChatBrowserHolder>((resolve, reject) => {
    const listeners: Array<() => void> = [];
    const entry = {
      title, choice, closed: false,
      exit: () => listeners.forEach((l) => l()),
      resolve: () => resolve({
        close: async () => { entry.closed = true; entry.exit(); },
        onExit: (l) => { listeners.push(l); },
      }),
      reject,
    };
    started.push(entry);
  });
  return { start, started };
}

describe('chat browsers', () => {
  it('opens one browser per chat, once, with a title that names the chat', async () => {
    const { start, started } = fakeHolders();
    const chats = new ChatBrowsers(start);
    const change = vi.fn();
    chats.on('change', change);

    const first = chats.ensure('p', '/proj', 'chat-1', null);
    const second = chats.ensure('p', '/proj', 'chat-1', undefined);
    expect(started).toHaveLength(1);
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'chat-1', status: 'starting' }]);
    started[0].resolve();
    await Promise.all([first, second]);
    expect(chats.isOpen('p', 'chat-1')).toBe(true);
    expect(started[0].choice).toBeNull();
    expect(chats.chatOfTitle(started[0].title)).toEqual({ projectId: 'p', chatId: 'chat-1' });
    expect(chats.titleFor('p', 'chat-1')).toBe(started[0].title);
    expect(change).toHaveBeenCalled();

    await chats.ensure('p', '/proj', 'chat-1', null);
    expect(started).toHaveLength(1);
  });

  it('forgets a browser that failed to open, closed, or exited', async () => {
    const { start, started } = fakeHolders();
    const chats = new ChatBrowsers(start);
    const failing = chats.ensure('p', '/proj', 'a', null);
    started[0].reject(new Error('Chromium is not installed'));
    await expect(failing).rejects.toThrow('Chromium is not installed');
    expect(chats.list()).toEqual([]);

    const opening = chats.ensure('p', '/proj', 'a', null);
    started[1].resolve();
    await opening;
    await chats.close('p', 'a');
    expect(started[1].closed).toBe(true);
    expect(chats.list()).toEqual([]);

    const again = chats.ensure('p', '/proj', 'a', null);
    started[2].resolve();
    await again;
    started[2].exit();
    expect(chats.isOpen('p', 'a')).toBe(false);
  });

  it("moves the New chat page's browser to its conversation", async () => {
    const { start, started } = fakeHolders();
    const chats = new ChatBrowsers(start);
    const opening = chats.ensure('p', '/proj', 'new', null);
    started[0].resolve();
    await opening;
    chats.adopt('p', 'session-1');
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'session-1', status: 'open' }]);
    expect(chats.chatOfTitle(started[0].title)).toEqual({ projectId: 'p', chatId: 'session-1' });
    expect(chats.titleFor('p', 'new')).not.toBe(started[0].title);
  });

  it('closes a browser that went away after it was seen live, and deleted chats', async () => {
    const { start, started } = fakeHolders();
    const chats = new ChatBrowsers(start);
    const opening = chats.ensure('p', '/proj', 'a', null);
    started[0].resolve();
    await opening;
    const title = started[0].title;
    chats.syncLive(new Set());
    expect(chats.isOpen('p', 'a')).toBe(true); // not seen live yet: still starting up
    chats.syncLive(new Set([title]));
    chats.syncLive(new Set());
    await vi.waitFor(() => expect(started[0].closed).toBe(true));

    const b = chats.ensure('p', '/proj', 'b', null);
    started[1].resolve();
    await b;
    await chats.closeChats('p', ['b']);
    expect(started[1].closed).toBe(true);
  });

  it("keeps the holder's browser open and on disk in its own folder", () => {
    const dir = path.join('/tmp', 'holder');
    expect(holderArgs(['-y', '@playwright/mcp@0.0.83', '--browser', 'chromium', '--isolated', '--sandbox', '--headless'], dir)).toEqual([
      '-y', '@playwright/mcp@0.0.83', '--browser', 'chromium', '--user-data-dir', path.join(dir, 'profile'), '--sandbox', '--headless',
      '--idle-timeout', '0', '--output-dir', dir,
    ]);
    expect(holderError('### Error\nError: Browser "chromium" is not installed. Run `npx playwright install`')).toBe('Browser "chromium" is not installed');
  });

  it("names a chat browser's session with its chat", () => {
    const sessions = toDrawerSessions(
      [
        { guid: 'g1', title: 'Workbench chat x', browserName: 'chromium', workspaceDir: '/tmp/chat-x' },
        { guid: 'g2', title: 'claude-code', browserName: 'chromium', workspaceDir: '/proj/.workbench/worktrees/tasks/1' },
      ],
      [{ id: 'p', path: '/proj' }],
      new Map([['/tmp/chat-x', '/proj']]),
      false,
      (title) => (title === 'Workbench chat x' ? { projectId: 'p', chatId: 'session-1' } : undefined),
    );
    expect(sessions.map((s) => [s.id, s.projectId, s.chatId])).toEqual([['g1', 'p', 'session-1'], ['g2', 'p', undefined]]);
  });
});
