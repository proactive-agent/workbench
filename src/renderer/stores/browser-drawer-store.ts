/**
 * The browser drawer: whether it is open, its width, the live Playwright sessions and their pages
 * (from the main process), and the page (tab) this window shows.
 *
 * The drawer keeps one view (open or closed, the tab shown) per context: each Claude chat shows
 * only its own browser, every other page all of the project's browsers. Switching chats or pages
 * and coming back finds the drawer as it was left; the width is the same everywhere.
 */

import { create } from 'zustand';
import {
  NEW_CHAT_BROWSER_ID,
  type BrowserBookmark,
  type BrowserDrawerPage,
  type BrowserDrawerSession,
  type BrowserDrawerState,
} from '../../shared/types/browser-drawer';

export const BROWSER_DRAWER_MIN_WIDTH = 420;
const BROWSER_DRAWER_DEFAULT_WIDTH = 760;
/**
 * The chat's narrowest width (px) beside the drawer: widening the drawer past it closes the chat
 * history, then collapses the app's sidebar (Insights.tsx), and the drawer stops there
 */
export const CHAT_MIN_WIDTH = 500;
/** The app's sidebar's width (px) expanded and collapsed to its icon rail (Sidebar's w-72 and w-14) */
export const APP_SIDEBAR_WIDTH = 288;
export const APP_SIDEBAR_COLLAPSED_WIDTH = 56;
const WIDTH_STORAGE_KEY = 'workbench.browserDrawer.width';

/**
 * A width within the drawer's limits for a window this wide: at most what leaves the chat
 * CHAT_MIN_WIDTH beside the app's collapsed sidebar (the chat history closed)
 */
export function clampDrawerWidth(width: number, windowWidth: number): number {
  const max = Math.max(BROWSER_DRAWER_MIN_WIDTH, Math.floor(windowWidth - APP_SIDEBAR_COLLAPSED_WIDTH - CHAT_MIN_WIDTH));
  return Math.round(Math.min(Math.max(width, BROWSER_DRAWER_MIN_WIDTH), max));
}

/**
 * The sessions a drawer shows: a chat's own browser (`chatId`), or every session of the project
 * (`chatId` null or left out: the pages other than the Claude chat)
 */
export function projectSessions(
  sessions: readonly BrowserDrawerSession[],
  projectId: string | null | undefined,
  chatId: string | null = null,
): BrowserDrawerSession[] {
  if (!projectId) return [];
  return sessions.filter((session) => session.projectId === projectId && (chatId === null || session.chatId === chatId));
}

/** The pages (tabs) of the sessions a drawer shows */
export function projectPages(state: BrowserDrawerState, projectId: string | null | undefined, chatId: string | null = null): BrowserDrawerPage[] {
  const sessionIds = new Set(projectSessions(state.sessions, projectId, chatId).map((session) => session.id));
  return state.pages.filter((page) => sessionIds.has(page.sessionId));
}

/** Sessions a drawer shows in `next` that weren't in `previous` (the newest last) */
export function newProjectSessions(
  previous: readonly BrowserDrawerSession[],
  next: readonly BrowserDrawerSession[],
  projectId: string | null | undefined,
  chatId: string | null = null,
): BrowserDrawerSession[] {
  const known = new Set(previous.map((session) => session.id));
  return projectSessions(next, projectId, chatId).filter((session) => !known.has(session.id));
}

/**
 * The tab to show: a page of the session to reveal once it has one, else the current tab while it
 * exists, else the first
 */
export function chooseSelectedPage(
  pages: readonly BrowserDrawerPage[],
  selectedPageId: string | null,
  revealSessionId: string | null,
): { selectedPageId: string | null; revealSessionId: string | null } {
  const revealed = revealSessionId ? pages.find((page) => page.sessionId === revealSessionId) : undefined;
  if (revealed) return { selectedPageId: revealed.id, revealSessionId: null };
  const current = selectedPageId && pages.some((page) => page.id === selectedPageId) ? selectedPageId : null;
  return { selectedPageId: current ?? pages[0]?.id ?? null, revealSessionId };
}

/** The key of a drawer context's view */
function drawerViewKey(projectId: string | null | undefined, chatId: string | null): string {
  return `${projectId ?? ''}|${chatId === null ? 'pages' : `chat:${chatId}`}`;
}

function readStoredWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : BROWSER_DRAWER_DEFAULT_WIDTH;
  } catch {
    return BROWSER_DRAWER_DEFAULT_WIDTH;
  }
}

/** How long after the user's input in a page a tab its browser opens counts as the user's (a link opened in a new tab, a popup) */
const USER_TAB_WINDOW_MS = 5000;
/** How long a tab the + button asked for may take to appear */
const NEW_TAB_WINDOW_MS = 10_000;

/** The page the user last clicked or typed in, and when (not state: nothing renders from it) */
let lastDrawerInput: { pageId: string; at: number } | null = null;

/** The user clicked or typed in a page of the drawer */
export function noteDrawerInput(pageId: string): void {
  lastDrawerInput = { pageId, at: Date.now() };
}

/** What a drawer context shows */
interface DrawerView {
  open: boolean;
  selectedPageId: string | null;
  revealSessionId: string | null;
}

const CLOSED_VIEW: DrawerView = { open: false, selectedPageId: null, revealSessionId: null };

interface BrowserDrawerStore extends DrawerView {
  width: number;
  state: BrowserDrawerState;
  /** Whether the main process sent its state yet (sessions before that are not new) */
  loaded: boolean;
  /** The context shown: the window's project, and the chat on the Claude page (null elsewhere) */
  projectId: string | null;
  chatId: string | null;
  /** The other contexts' views, by drawerViewKey */
  views: Record<string, DrawerView>;
  /** A new tab was asked for in this session: it is shown once it appears */
  newTabSessionId: string | null;
  /** When the + button asked for it (a tab that never appeared doesn't count later) */
  newTabAskedAt: number;
  /**
   * A tab that just opened and is shown (the + button, a link opened in a new tab, a page's popup):
   * the drawer focuses it (its address bar for an empty one), then clears this
   */
  focusPageId: string | null;
  /** Whether the + button asked for the tab focusPageId names (it takes the focus wherever it is) */
  focusRequestedByUser: boolean;
  clearFocusRequest: () => void;
  /** Each browser's bookmarks bar (its profile's), read once per browser */
  bookmarks: Record<string, BrowserBookmark[]>;
  loadBookmarks: (sessionId: string) => void;
  /**
   * The drawer collapsed the app's sidebar to keep the chat wide enough (Insights.tsx): collapsed
   * while set, on top of the user's own choice (never saved), and expanded again by the drawer
   */
  appSidebarCollapsedByDrawer: boolean;
  setAppSidebarCollapsedByDrawer: (collapsed: boolean) => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  /** An open drawer gets narrower by `px` (a sidebar it had closed was opened: the chat keeps its width) */
  narrowBy: (px: number) => void;
  selectPage: (pageId: string) => void;
  /** Show another context (keeping the current one's view for when it comes back) */
  setContext: (projectId: string | null, chatId: string | null) => void;
  /** The New chat page became a conversation: its view (and browser) belong to it */
  adoptChatView: (projectId: string, chatId: string) => void;
  /** Open a new tab in a session's browser and show it */
  openNewTab: (sessionId: string) => void;
  /** The main process's state; a session the drawer shows that just started opens the drawer on it */
  receiveState: (state: BrowserDrawerState, projectId: string | null | undefined) => void;
}

const viewOf = (state: DrawerView): DrawerView => ({
  open: state.open,
  selectedPageId: state.selectedPageId,
  revealSessionId: state.revealSessionId,
});

export const useBrowserDrawerStore = create<BrowserDrawerStore>((set, get) => ({
  ...CLOSED_VIEW,
  width: readStoredWidth(),
  state: { available: true, sessions: [], pages: [] },
  loaded: false,
  projectId: null,
  chatId: null,
  views: {},
  newTabSessionId: null,
  newTabAskedAt: 0,
  focusPageId: null,
  focusRequestedByUser: false,
  clearFocusRequest: () => set({ focusPageId: null, focusRequestedByUser: false }),
  bookmarks: {},
  loadBookmarks: (sessionId) => {
    if (sessionId in get().bookmarks) return;
    set((s) => ({ bookmarks: { ...s.bookmarks, [sessionId]: [] } }));
    void window.electronAPI.getBrowserBookmarks(sessionId).then((result) => {
      if (result.success && result.data?.length && sessionId in get().bookmarks) {
        set((s) => ({ bookmarks: { ...s.bookmarks, [sessionId]: result.data ?? [] } }));
      }
    }, () => undefined);
  },
  appSidebarCollapsedByDrawer: false,
  setAppSidebarCollapsedByDrawer: (appSidebarCollapsedByDrawer) => set({ appSidebarCollapsedByDrawer }),
  setOpen: (open) => set({ open }),
  setWidth: (width) => {
    set({ width });
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // The width is remembered only where storage works
    }
  },
  narrowBy: (px) => {
    const { open, width, setWidth } = get();
    if (!open) return;
    const shown = clampDrawerWidth(width, window.innerWidth);
    setWidth(clampDrawerWidth(shown - px, window.innerWidth));
  },
  selectPage: (pageId) => set({ selectedPageId: pageId, revealSessionId: null }),
  setContext: (projectId, chatId) => {
    const current = get();
    if (current.projectId === projectId && current.chatId === chatId) return;
    const views = { ...current.views, [drawerViewKey(current.projectId, current.chatId)]: viewOf(current) };
    const next = views[drawerViewKey(projectId, chatId)] ?? CLOSED_VIEW;
    const selection = chooseSelectedPage(projectPages(current.state, projectId, chatId), next.selectedPageId, next.revealSessionId);
    set({ projectId, chatId, views, ...next, ...selection, newTabSessionId: null, focusPageId: null, focusRequestedByUser: false });
  },
  adoptChatView: (projectId, chatId) => {
    const current = get();
    const from = drawerViewKey(projectId, NEW_CHAT_BROWSER_ID);
    const to = drawerViewKey(projectId, chatId);
    const views = { ...current.views };
    // Shown now: the view moves with the context
    if (current.projectId === projectId && current.chatId === NEW_CHAT_BROWSER_ID) {
      delete views[from];
      set({ chatId, views });
      return;
    }
    if (views[from]) {
      views[to] = views[from];
      delete views[from];
      set({ views });
    }
  },
  openNewTab: (sessionId) => {
    set({ newTabSessionId: sessionId, newTabAskedAt: Date.now() });
    window.electronAPI.newBrowserPage(sessionId);
  },
  receiveState: (state, projectId) => {
    const { loaded, state: previous, selectedPageId, revealSessionId, chatId, newTabSessionId, newTabAskedAt } = get();
    const started = loaded && state.available ? newProjectSessions(previous.sessions, state.sessions, projectId, chatId) : [];
    const newest = started[started.length - 1];
    const pending = revealSessionId && state.sessions.some((session) => session.id === revealSessionId) ? revealSessionId : null;
    const pages = projectPages(state, projectId, chatId);
    // A tab the user opened is shown: the one the + button asked for, else one the browser opened
    // right after the user clicked or typed in a page of it (a link opened in a new tab, a popup).
    // Tabs Claude opens, or a restored browser reopens, leave the tab shown alone
    const now = Date.now();
    const known = new Set(previous.pages.map((page) => page.id));
    const wantsNewTab = newTabSessionId && now - newTabAskedAt < NEW_TAB_WINDOW_MS ? newTabSessionId : null;
    const asked = wantsNewTab ? pages.find((page) => page.sessionId === wantsNewTab && !known.has(page.id)) : undefined;
    const inputSession = lastDrawerInput && now - lastDrawerInput.at < USER_TAB_WINDOW_MS
      ? previous.pages.find((page) => page.id === lastDrawerInput?.pageId)?.sessionId
      : undefined;
    const opened = loaded && inputSession ? pages.filter((page) => !known.has(page.id) && page.sessionId === inputSession) : [];
    const newTab = asked ?? opened[opened.length - 1];
    const selection = newTab
      ? { selectedPageId: newTab.id, revealSessionId: null }
      : chooseSelectedPage(pages, selectedPageId, newest?.id ?? pending);
    // Browsers that closed forget their bookmarks (another browser of the chat reads its own)
    const live = new Set(state.sessions.map((session) => session.id));
    const { bookmarks } = get();
    const gone = Object.keys(bookmarks).filter((id) => !live.has(id));
    set({
      state,
      loaded: true,
      ...(gone.length ? { bookmarks: Object.fromEntries(Object.entries(bookmarks).filter(([id]) => live.has(id))) } : {}),
      ...selection,
      ...(asked || (newTabSessionId && !wantsNewTab) ? { newTabSessionId: null } : {}),
      ...(newTab ? { focusPageId: newTab.id, focusRequestedByUser: !!asked } : {}),
      ...(newest ? { open: true } : {}),
    });
  },
}));
