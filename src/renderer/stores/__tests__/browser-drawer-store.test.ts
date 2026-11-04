import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBrowserDrawerStore, clampDrawerWidth, chooseSelectedPage, projectPages, BROWSER_DRAWER_MIN_WIDTH } from '../browser-drawer-store';
import type { BrowserDrawerPage, BrowserDrawerSession } from '../../../shared/types/browser-drawer';

const session = (id: string, projectId?: string, chatId?: string): BrowserDrawerSession => ({
  id, title: 'claude-code', browserName: 'chromium', ...(projectId ? { projectId } : {}), ...(chatId ? { chatId } : {}),
});
const page = (id: string, sessionId: string): BrowserDrawerPage => ({ id, sessionId, title: id, url: `https://${id}.test/` });

describe('browser drawer store', () => {
  beforeEach(() => {
    useBrowserDrawerStore.setState({
      open: false, loaded: false, selectedPageId: null, revealSessionId: null,
      state: { available: true, sessions: [], pages: [] },
      projectId: 'app', chatId: null, views: {}, newTabSessionId: null,
    });
  });

  it("opens on a session of the window's project that starts and shows its page once known", () => {
    const { receiveState } = useBrowserDrawerStore.getState();
    receiveState({ available: true, sessions: [session('old', 'app')], pages: [] }, 'app');
    expect(useBrowserDrawerStore.getState().open).toBe(false);

    receiveState({ available: true, sessions: [session('old', 'app'), session('elsewhere', 'other'), session('cli')], pages: [] }, 'app');
    expect(useBrowserDrawerStore.getState().open).toBe(false);

    receiveState({ available: true, sessions: [session('old', 'app'), session('new', 'app')], pages: [page('o1', 'old')] }, 'app');
    expect(useBrowserDrawerStore.getState()).toMatchObject({ open: true, revealSessionId: 'new', selectedPageId: 'o1' });

    receiveState({ available: true, sessions: [session('old', 'app'), session('new', 'app')], pages: [page('o1', 'old'), page('n1', 'new')] }, 'app');
    expect(useBrowserDrawerStore.getState()).toMatchObject({ revealSessionId: null, selectedPageId: 'n1' });
  });

  it('stays closed when the user closed it and nothing new starts', () => {
    const { receiveState, setOpen } = useBrowserDrawerStore.getState();
    receiveState({ available: true, sessions: [], pages: [] }, 'app');
    receiveState({ available: true, sessions: [session('a', 'app')], pages: [] }, 'app');
    setOpen(false);
    receiveState({ available: true, sessions: [session('a', 'app')], pages: [page('a1', 'a')] }, 'app');
    expect(useBrowserDrawerStore.getState().open).toBe(false);
  });

  it("lists only the project's pages as tabs and keeps the chosen tab while it exists", () => {
    const state = { available: true, sessions: [session('a', 'app'), session('b', 'other')], pages: [page('a1', 'a'), page('b1', 'b'), page('a2', 'a')] };
    expect(projectPages(state, 'app').map((p) => p.id)).toEqual(['a1', 'a2']);
    expect(chooseSelectedPage([page('a1', 'a'), page('a2', 'a')], 'a2', null)).toEqual({ selectedPageId: 'a2', revealSessionId: null });
    expect(chooseSelectedPage([page('a1', 'a')], 'gone', null)).toEqual({ selectedPageId: 'a1', revealSessionId: null });
    expect(chooseSelectedPage([], 'gone', null)).toEqual({ selectedPageId: null, revealSessionId: null });
  });

  it('narrows an open drawer by the room a sidebar the user opened again takes, within its limits', () => {
    vi.stubGlobal('window', { innerWidth: 1600 });
    try {
      useBrowserDrawerStore.setState({ open: true, width: 1044 });
      useBrowserDrawerStore.getState().narrowBy(256);
      expect(useBrowserDrawerStore.getState().width).toBe(788);
      // From the width it is shown at (a stored width past the limit counts as the limit)
      useBrowserDrawerStore.setState({ width: 5000 });
      useBrowserDrawerStore.getState().narrowBy(232);
      expect(useBrowserDrawerStore.getState().width).toBe(812);
      // Never below its narrowest width, and a closed drawer stays as it is
      useBrowserDrawerStore.getState().narrowBy(1000);
      expect(useBrowserDrawerStore.getState().width).toBe(BROWSER_DRAWER_MIN_WIDTH);
      useBrowserDrawerStore.setState({ open: false, width: 900 });
      useBrowserDrawerStore.getState().narrowBy(256);
      expect(useBrowserDrawerStore.getState().width).toBe(900);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps its width within the window', () => {
    expect(clampDrawerWidth(100, 1600)).toBe(BROWSER_DRAWER_MIN_WIDTH);
    expect(clampDrawerWidth(700, 1600)).toBe(700);
    // Up to what leaves the chat 500px beside the app's collapsed sidebar (56px)
    expect(clampDrawerWidth(1500, 1600)).toBe(1044);
    expect(clampDrawerWidth(1044, 1600)).toBe(1044);
    expect(clampDrawerWidth(900, 600)).toBe(BROWSER_DRAWER_MIN_WIDTH);
  });

  it("shows a chat's own browser only, and keeps each context's view", () => {
    const { receiveState, setContext, setOpen } = useBrowserDrawerStore.getState();
    const sessions = [session('task', 'app'), session('chatA', 'app', 'a'), session('chatB', 'app', 'b')];
    const pages = [page('t1', 'task'), page('a1', 'chatA'), page('b1', 'chatB')];
    receiveState({ available: true, sessions: [], pages: [] }, 'app');
    receiveState({ available: true, sessions, pages }, 'app');
    // Other pages: every browser of the project, opened by the sessions that started
    expect(useBrowserDrawerStore.getState().open).toBe(true);
    expect(projectPages(useBrowserDrawerStore.getState().state, 'app').map((p) => p.id)).toEqual(['t1', 'a1', 'b1']);
    expect(projectPages(useBrowserDrawerStore.getState().state, 'app', 'a').map((p) => p.id)).toEqual(['a1']);

    // Chat A: closed until opened there, showing its own tab
    setContext('app', 'a');
    expect(useBrowserDrawerStore.getState()).toMatchObject({ open: false, selectedPageId: 'a1' });
    setOpen(true);
    setContext('app', 'b');
    expect(useBrowserDrawerStore.getState()).toMatchObject({ open: false, selectedPageId: 'b1' });
    setContext('app', 'a');
    expect(useBrowserDrawerStore.getState()).toMatchObject({ open: true, selectedPageId: 'a1' });
    setContext('app', null);
    expect(useBrowserDrawerStore.getState().open).toBe(true);
  });

  it("opens only for a session of the chat shown, and the New chat page's view moves to its conversation", () => {
    const { receiveState, setContext, adoptChatView, setOpen } = useBrowserDrawerStore.getState();
    setContext('app', 'new');
    receiveState({ available: true, sessions: [], pages: [] }, 'app');
    receiveState({ available: true, sessions: [session('task', 'app')], pages: [] }, 'app');
    expect(useBrowserDrawerStore.getState().open).toBe(false);
    receiveState({ available: true, sessions: [session('task', 'app'), session('mine', 'app', 'new')], pages: [page('m1', 'mine')] }, 'app');
    expect(useBrowserDrawerStore.getState()).toMatchObject({ open: true, selectedPageId: 'm1' });

    adoptChatView('app', 'session-1');
    expect(useBrowserDrawerStore.getState()).toMatchObject({ chatId: 'session-1', open: true });
    setOpen(false);
    setContext('app', null);
    setContext('app', 'session-1');
    expect(useBrowserDrawerStore.getState().open).toBe(false);
  });

  it('shows a tab the user opened once it appears', () => {
    vi.stubGlobal('window', { electronAPI: { newBrowserPage: () => {} } });
    const { receiveState, openNewTab } = useBrowserDrawerStore.getState();
    const sessions = [session('s', 'app')];
    receiveState({ available: true, sessions, pages: [page('p1', 's')] }, 'app');
    openNewTab('s');
    receiveState({ available: true, sessions, pages: [page('p1', 's'), page('p2', 's')] }, 'app');
    expect(useBrowserDrawerStore.getState()).toMatchObject({ selectedPageId: 'p2', newTabSessionId: null });
    vi.unstubAllGlobals();
  });
});
