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
  type BrowserExtensions,
} from '../../shared/types/browser-drawer';
import { saveSettings, useSettingsStore } from './settings-store';
import { APP_SIDEBAR_COLLAPSED_WIDTH } from '../lib/layout-widths';

export const BROWSER_DRAWER_MIN_WIDTH = 420;
const BROWSER_DRAWER_DEFAULT_WIDTH = 760;
/**
 * The chat's narrowest width (px) until the Claude page has measured its own (`chatMinWidth`: what
 * the composer's buttons need, useChatMinWidth.ts)
 */
const DEFAULT_CHAT_MIN_WIDTH = 500;

/** An extension's popup asked for and not shown yet (see the store's extensionOpening) */
export interface ExtensionOpening {
  token: number;
  openerId: string;
  extensionId: string;
  /** The popup's page, once the browser answered with it */
  popupId?: string;
}
const WIDTH_STORAGE_KEY = 'workbench.browserDrawer.width';

/**
 * A width within the drawer's limits for a window this wide: at most what leaves the chat its
 * narrowest width (`chatMinWidth`) beside the app's collapsed sidebar (the chat history closed)
 */
export function clampDrawerWidth(width: number, windowWidth: number, chatMinWidth: number): number {
  const max = Math.max(BROWSER_DRAWER_MIN_WIDTH, Math.floor(windowWidth - APP_SIDEBAR_COLLAPSED_WIDTH - chatMinWidth));
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
  // Extensions' popups show over their page, not as tabs
  return state.pages.filter((page) => !page.popup && sessionIds.has(page.sessionId));
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
  /**
   * Why opening a chat's browser failed last, by `<project>:<chat>`: kept here, since the drawer
   * shows its loader while the browser starts (the empty state that asked goes meanwhile)
   */
  openErrors: Record<string, string>;
  setOpenError: (projectId: string, chatId: string, error: string | null) => void;
  /** Each browser's bookmarks bar (its profile's), read once per browser */
  bookmarks: Record<string, BrowserBookmark[]>;
  loadBookmarks: (sessionId: string) => void;
  /** Each chat browser's extensions (absent: not read yet, or it ran none when asked) */
  extensions: Record<string, BrowserExtensions>;
  /** Read a browser's extensions (again) */
  loadExtensions: (sessionId: string) => void;
  /**
   * Switch a browser's extension on or off: kept in Settings for every chat browser of its profile,
   * applied at once where the browser can (Chromium; Firefox's wait for it to start again)
   */
  switchExtension: (sessionId: string, extensionId: string, enabled: boolean) => Promise<void>;
  /**
   * The drawer collapsed the app's sidebar to keep the chat wide enough (Insights.tsx): collapsed
   * while set, on top of the user's own choice (never saved), and expanded again by the drawer
   */
  appSidebarCollapsedByDrawer: boolean;
  setAppSidebarCollapsedByDrawer: (collapsed: boolean) => void;
  /**
   * The chat's narrowest width (px) beside the drawer: what its composer's buttons need
   * (useChatMinWidth.ts). Widening the drawer, or the chat needing more, past it closes the chat
   * history, then collapses the app's sidebar (Insights.tsx), and the drawer stops there
   */
  chatMinWidth: number;
  setChatMinWidth: (width: number) => void;
  /**
   * The drawer closed the chat history (not the user), so it may open it again (useChatRoom): kept
   * for the app's life, like the history's own state, across visits to the Claude page
   */
  historyClosedByDrawer: boolean;
  /**
   * An extension's popup asked for and not shown yet (its page loads, the browser measures it): the
   * drawer shows its box with a loader meanwhile, until the popup the browser answered with
   * (`popupId`) is listed. `token` tells one ask from the next
   */
  extensionOpening: ExtensionOpening | null;
  setExtensionOpening: (opening: ExtensionOpening | null) => void;
  setHistoryClosedByDrawer: (closed: boolean) => void;
  setOpen: (open: boolean) => void;
  /** The drawer's width, remembered unless `save` is false (while its edge is dragged) */
  setWidth: (width: number, save?: boolean) => void;
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
  openErrors: {},
  setOpenError: (projectId, chatId, error) => set((s) => {
    const key = `${projectId}:${chatId}`;
    const { [key]: _previous, ...rest } = s.openErrors;
    return { openErrors: error ? { ...rest, [key]: error } : rest };
  }),
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
  extensions: {},
  loadExtensions: (sessionId) => {
    void window.electronAPI.getBrowserExtensions(sessionId).then((result) => {
      if (!result.success) return;
      const { [sessionId]: _previous, ...others } = get().extensions;
      set({ extensions: result.data ? { ...others, [sessionId]: result.data } : others });
    }, () => undefined);
  },
  switchExtension: async (sessionId, extensionId, enabled) => {
    const current = get().extensions[sessionId];
    if (!current) return;
    // Shown at once; the browser's answer replaces it
    const shown = (info: BrowserExtensions) => ({
      ...info,
      extensions: info.extensions.map((extension) => (extension.id === extensionId ? { ...extension, enabled } : extension)),
    });
    set((s) => ({ extensions: { ...s.extensions, [sessionId]: shown(current) } }));
    const browser = useSettingsStore.getState().settings.browser ?? {};
    const switches = browser.extensionSwitches ?? {};
    await saveSettings({
      browser: {
        ...browser,
        extensionSwitches: { ...switches, [current.browserId]: { ...switches[current.browserId], [extensionId]: enabled } },
      },
    });
    const result = await window.electronAPI.getBrowserExtensions(sessionId, { [extensionId]: enabled }).catch(() => null);
    if (result?.success && result.data && sessionId in get().extensions) {
      set((s) => ({ extensions: { ...s.extensions, [sessionId]: result.data as BrowserExtensions } }));
    }
  },
  appSidebarCollapsedByDrawer: false,
  setAppSidebarCollapsedByDrawer: (appSidebarCollapsedByDrawer) => set({ appSidebarCollapsedByDrawer }),
  historyClosedByDrawer: false,
  extensionOpening: null,
  setExtensionOpening: (extensionOpening) => set({ extensionOpening }),
  setHistoryClosedByDrawer: (historyClosedByDrawer) => set({ historyClosedByDrawer }),
  chatMinWidth: DEFAULT_CHAT_MIN_WIDTH,
  setChatMinWidth: (chatMinWidth) => {
    if (chatMinWidth !== get().chatMinWidth) set({ chatMinWidth });
  },
  setOpen: (open) => set({ open }),
  setWidth: (width, save = true) => {
    set({ width });
    if (!save) return;
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // The width is remembered only where storage works
    }
  },
  narrowBy: (px) => {
    const { open, width, setWidth, chatMinWidth } = get();
    if (!open) return;
    const shown = clampDrawerWidth(width, window.innerWidth, chatMinWidth);
    setWidth(clampDrawerWidth(shown - px, window.innerWidth, chatMinWidth));
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
    const { bookmarks, extensions, openErrors } = get();
    const gone = Object.keys(bookmarks).filter((id) => !live.has(id));
    const goneExtensions = Object.keys(extensions).some((id) => !live.has(id));
    // A chat's browser that opened (from the drawer or a chat's turn) has no open error left
    const openChats = new Set((state.chatBrowsers ?? []).filter((browser) => browser.status === 'open').map((browser) => `${browser.projectId}:${browser.chatId}`));
    const settled = Object.keys(openErrors).filter((key) => openChats.has(key));
    set({
      state,
      loaded: true,
      ...(settled.length ? { openErrors: Object.fromEntries(Object.entries(openErrors).filter(([key]) => !openChats.has(key))) } : {}),
      ...(gone.length ? { bookmarks: Object.fromEntries(Object.entries(bookmarks).filter(([id]) => live.has(id))) } : {}),
      ...(goneExtensions ? { extensions: Object.fromEntries(Object.entries(extensions).filter(([id]) => live.has(id))) } : {}),
      ...selection,
      ...(asked || (newTabSessionId && !wantsNewTab) ? { newTabSessionId: null } : {}),
      ...(newTab ? { focusPageId: newTab.id, focusRequestedByUser: !!asked } : {}),
      ...(newest ? { open: true } : {}),
    });
  },
}));
