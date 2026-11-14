import os from 'os';
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { ChatBrowsers, holderArgs, holderError, homepageUrl, type ChatBrowserHolder, type StartChatBrowserHolder } from '../chat-browsers';
import { toDrawerSessions } from '../browser-drawer-service';
import { SavedChatTabs } from '../saved-tabs';
import { rm, stat } from 'fs/promises';

/** Kept tabs in memory only (never the test app's data folder) */
const memoryTabs = () => new SavedChatTabs(() => null);

/** A holder that starts when `start()` is called and records closes */
function fakeHolders() {
  const started: Array<{ title: string; choice: unknown; restore: unknown; resolve: () => void; reject: (e: Error) => void; exit: () => void; closed: boolean }> = [];
  const start: StartChatBrowserHolder = ({ title, choice, restore }) => new Promise<ChatBrowserHolder>((resolve, reject) => {
    const listeners: Array<() => void> = [];
    const entry = {
      title, choice, restore, closed: false,
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

describe('chat browsers left by a crash', () => {
  const restorable = (chatId: string, dir = os.tmpdir()) => ({
    dir,
    record: {
      projectId: 'p', projectPath: '/proj', chatId, browserId: null, profileCopyDir: null, updatedAt: Date.now(),
      tabs: [{ url: 'https://a.test/', title: 'A' }, { url: 'about:blank', title: '' }, { url: 'https://b.test/', title: 'B' }],
    },
  });

  it('lists them for their chats and starts the chat browser from them', async () => {
    const { start, started } = fakeHolders();
    const discard = vi.fn(async () => undefined);
    const chats = new ChatBrowsers(start, discard, memoryTabs());
    const left = restorable('session-1');
    chats.addRestorable(left);
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'session-1', status: 'restorable', tabs: 2 }]);
    expect(chats.isOpen('p', 'session-1')).toBe(false);

    const opening = chats.ensure('p', '/proj', 'session-1', undefined);
    expect(started[0].restore).toBe(left);
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'session-1', status: 'starting' }]);
    started[0].resolve();
    await opening;
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'session-1', status: 'open' }]);
    expect(discard).not.toHaveBeenCalled();
  });

  it('keeps one whose start failed, and removes those of deleted chats or chats that have a browser', async () => {
    const { start, started } = fakeHolders();
    const discard = vi.fn(async () => undefined);
    const chats = new ChatBrowsers(start, discard, memoryTabs());
    const left = restorable('session-1');
    chats.addRestorable(left);
    const failing = chats.ensure('p', '/proj', 'session-1', undefined);
    started[0].reject(new Error('Chromium is not installed'));
    await expect(failing).rejects.toThrow('Chromium is not installed');
    await vi.waitFor(() => expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'session-1', status: 'restorable', tabs: 2 }]));

    await chats.closeChats('p', ['session-1']);
    expect(discard).toHaveBeenCalledWith(left);
    expect(chats.list()).toEqual([]);

    const opening = chats.ensure('p', '/proj', 'session-2', null);
    const late = restorable('session-2');
    chats.addRestorable(late);
    expect(discard).toHaveBeenCalledWith(late);
    started[1].resolve();
    await opening;
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'session-2', status: 'open' }]);
  });
});

describe('chat browsers', () => {
  it('opens one browser per chat, once, with a title that names the chat', async () => {
    const { start, started } = fakeHolders();
    const chats = new ChatBrowsers(start, undefined, memoryTabs());
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

  it('opens no second browser for a chat until the one closed while starting has closed', async () => {
    const { start, started } = fakeHolders();
    const chats = new ChatBrowsers(start, undefined, memoryTabs());
    const opening = chats.ensure('p', '/proj', 'a', null);
    const closed = chats.close('p', 'a');
    const reopening = chats.ensure('p', '/proj', 'a', null);
    // The first is still starting: nothing else starts under its title
    expect(started).toHaveLength(1);
    started[0].resolve();
    await expect(opening).rejects.toThrow('The browser was closed');
    await closed;
    expect(started[0].closed).toBe(true);
    await vi.waitFor(() => expect(started).toHaveLength(2));
    started[1].resolve();
    await reopening;
    expect(chats.isOpen('p', 'a')).toBe(true);
  });

  it('forgets a browser that failed to open, closed, or exited', async () => {
    const { start, started } = fakeHolders();
    const chats = new ChatBrowsers(start, undefined, memoryTabs());
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
    const chats = new ChatBrowsers(start, undefined, memoryTabs());
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
    const chats = new ChatBrowsers(start, undefined, memoryTabs());
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
    expect(sessions.map((s) => [s.id, s.projectId, s.chatId])).toEqual([['g1', 'p', 'session-1'], ['g2', undefined, undefined]]);
  });
});

describe('restarting a chat browser', () => {
  /** Holders that start at once and can be suspended: closed, keeping what they were */
  function restartableHolders() {
    const kept = (n: number) => ({
      dir: os.tmpdir(),
      record: { projectId: 'p', projectPath: '/proj', chatId: 'session-1', browserId: 'firefox:x', profileCopyDir: `/copy-${n}`, tabs: [], updatedAt: n },
    });
    const starts: Array<{ restore: unknown; choice: unknown }> = [];
    let fail = false;
    const start: StartChatBrowserHolder = async ({ restore, choice }) => {
      starts.push({ restore, choice });
      if (fail) throw new Error('Firefox did not start');
      const n = starts.length;
      const listeners: Array<() => void> = [];
      return {
        browser: { id: 'firefox:x' } as never,
        close: async () => listeners.forEach((l) => l()),
        onExit: (l) => { listeners.push(l); },
        suspend: async () => {
          listeners.forEach((l) => l());
          return kept(n);
        },
      };
    };
    return { start, starts, kept, failNext: () => { fail = true; } };
  }

  it('starts it again from its folder, copy and tabs with the same browser, open for its chat throughout', async () => {
    const { start, starts, kept } = restartableHolders();
    const chats = new ChatBrowsers(start, undefined, memoryTabs());
    await chats.ensure('p', '/proj', 'session-1', undefined);
    const restarting = chats.restart('p', 'session-1');
    // Its old holder exited meanwhile: the chat's browser is starting, not gone
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'session-1', status: 'starting' }]);
    await restarting;
    expect(starts[1]).toEqual({ restore: kept(1), choice: { id: 'firefox:x' } });
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'session-1', status: 'open' }]);
    // A chat without an open browser has nothing to restart
    await chats.restart('p', 'other');
    expect(starts).toHaveLength(2);
  });

  it('keeps what a failed restart was to open again', async () => {
    const { start, failNext } = restartableHolders();
    const chats = new ChatBrowsers(start, undefined, memoryTabs());
    await chats.ensure('p', '/proj', 'session-1', undefined);
    failNext();
    await expect(chats.restart('p', 'session-1')).rejects.toThrow('Firefox did not start');
    await vi.waitFor(() => expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'session-1', status: 'restorable', tabs: 0 }]));
  });
});

describe('the homepage a new chat browser opens', () => {
  it('opens an address the drawer opens, and nothing for a blank or other one', () => {
    expect(homepageUrl(' https://start.test/ ')).toBe('https://start.test/');
    expect(homepageUrl('file:///home/me/start.html')).toBe('file:///home/me/start.html');
    for (const value of [undefined, '', 'about:blank', 'javascript:alert(1)', 'chrome://settings']) {
      expect(homepageUrl(value)).toBeUndefined();
    }
  });
});

describe("a chat browser's tabs, kept when it closes", () => {
  const A = { url: 'https://a.test/', title: 'A' };
  const B = { url: 'https://b.test/', title: 'B' };
  /** Holders that report `tabs`, recording what each start was given */
  function tabbedHolders(tabs: Array<{ url: string; title: string }>) {
    const starts: Array<Parameters<StartChatBrowserHolder>[0]> = [];
    const start: StartChatBrowserHolder = async (options) => {
      starts.push(options);
      const listeners: Array<() => void> = [];
      return {
        close: async () => listeners.forEach((l) => l()),
        onExit: (l) => { listeners.push(l); },
        tabs: () => tabs,
      };
    };
    return { start, starts };
  }

  it('keeps them when the browser is closed and opens them again with it, which no longer lists them', async () => {
    const { start, starts } = tabbedHolders([A, { url: 'about:blank', title: '' }, B]);
    const chats = new ChatBrowsers(start, undefined, memoryTabs());
    await chats.ensure('p', '/proj', 'chat', undefined);
    await chats.close('p', 'chat');
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'chat', status: 'saved', tabs: 2 }]);

    await chats.ensure('p', '/proj', 'chat', undefined, { withUrl: true });
    expect(starts[1]).toMatchObject({ tabs: [A, B] });
    expect(starts[1].withUrl?.()).toBe(true);
    expect(chats.list()).toEqual([{ projectId: 'p', chatId: 'chat', status: 'open' }]);
  });

  it('keeps none when its last tab is closed or its chat deleted, and keeps them when it goes away or the app quits', async () => {
    const saved = new SavedChatTabs(() => null);
    const { start } = tabbedHolders([A]);
    const chats = new ChatBrowsers(start, undefined, saved);
    await chats.ensure('p', '/proj', 'chat', undefined);
    await chats.close('p', 'chat', { keepTabs: false });
    expect(saved.get('p', 'chat')).toEqual([]);

    await chats.ensure('p', '/proj', 'chat', undefined);
    await chats.close('p', 'chat');
    await chats.closeChats('p', ['chat']);
    expect(saved.get('p', 'chat')).toEqual([]);

    await chats.ensure('p', '/proj', 'other', undefined);
    await chats.shutdown();
    expect(saved.get('p', 'other')).toEqual([A]);
  });

  it("moves the New chat page's tabs to the conversation it created", () => {
    const saved = new SavedChatTabs(() => null);
    saved.set('p', 'new', [A]);
    const chats = new ChatBrowsers(tabbedHolders([]).start, undefined, saved);
    chats.adopt('p', 'chat-1', 'new');
    expect(saved.get('p', 'new')).toEqual([]);
    expect(saved.get('p', 'chat-1')).toEqual([A]);
  });

  it('keeps them in an owner-only file across starts, read in the background, with changes made meanwhile on top', async () => {
    const file = path.join(os.tmpdir(), `wb-saved-tabs-${process.pid}-${Date.now()}.json`);
    try {
      const first = new SavedChatTabs(() => file);
      await first.ready;
      first.set('p', 'chat', [A, B]);
      first.flushSync();
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);

      const second = new SavedChatTabs(() => file);
      // Changed before the file was read: applied on top of it
      second.set('p', 'other', [B]);
      await second.ready;
      expect(second.get('p', 'chat')).toEqual([A, B]);
      expect(second.get('p', 'other')).toEqual([B]);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('forgets the tabs of chats that are gone', async () => {
    const saved = memoryTabs();
    saved.set('p', 'kept', [A]);
    saved.set('p', 'gone', [B]);
    expect(await saved.prune(async (_projectId, chatId) => chatId === 'kept')).toBe(1);
    expect(saved.list()).toEqual([{ projectId: 'p', chatId: 'kept', tabs: 1 }]);
  });

  it('keeps them through a close while the browser was still starting', async () => {
    const saved = memoryTabs();
    saved.set('p', 'chat', [A, B]);
    const { start, started } = fakeHolders();
    const chats = new ChatBrowsers(start, undefined, saved);
    const opening = chats.ensure('p', '/proj', 'chat', undefined);
    const closing = chats.close('p', 'chat');
    started[0].resolve();
    await expect(opening).rejects.toThrow();
    await closing;
    expect(saved.get('p', 'chat')).toEqual([A, B]);
  });

  it("gives the first tab to a turn's address that asks while the browser starts", async () => {
    const seen: boolean[] = [];
    const start: StartChatBrowserHolder = async ({ withUrl }) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      seen.push(withUrl?.() === true);
      return { close: async () => undefined, onExit: () => undefined };
    };
    const chats = new ChatBrowsers(start, undefined, memoryTabs());
    const byUser = chats.ensure('p', '/proj', 'chat', undefined);
    const byTurn = chats.ensure('p', '/proj', 'chat', undefined, { withUrl: true });
    await Promise.all([byUser, byTurn]);
    expect(seen).toEqual([true]);
  });
});
