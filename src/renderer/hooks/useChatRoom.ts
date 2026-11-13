/**
 * Keeps the Claude chat as wide as it needs (`chatMinWidth`, useChatMinWidth) beside the browser
 * drawer, without rendering the chat page again while the drawer is dragged: it follows the stores
 * and the window outside React and works out the chat's width from the layout's state (the window,
 * the drawer, the app's sidebar and the chat history), never from the page, which React may not
 * have updated yet and whose sidebar animates its width.
 *
 * Whatever leaves the chat less room than it needs with the drawer open (the drawer opening or
 * widening, the chat needing more, the window narrowing, the page showing with the drawer open)
 * closes the chat history, then collapses the app's sidebar; the other way round (the drawer
 * narrowing or closing, the chat needing less, the window widening) opens them again in the other
 * order, each once the chat keeps its width with it. Only what the drawer closed opens again: a
 * history or sidebar the user closed stays closed. Only such changes close them, so one the user
 * opens again (which narrows the drawer by its width, once it shows) stays open.
 */
import { useEffect } from 'react';
import { clampDrawerWidth, useBrowserDrawerStore } from '../stores/browser-drawer-store';
import { APP_SIDEBAR_COLLAPSED_WIDTH, APP_SIDEBAR_WIDTH, CHAT_HISTORY_WIDTH } from '../lib/layout-widths';
import { useInsightsStore } from '../stores/insights-store';
import { useSettingsStore } from '../stores/settings-store';

const APP_SIDEBAR_COLLAPSE_GAIN = APP_SIDEBAR_WIDTH - APP_SIDEBAR_COLLAPSED_WIDTH;

interface Layout {
  open: boolean;
  width: number;
  chatMinWidth: number;
  windowWidth: number;
}

/** The chat's width as the stores have the layout now */
function chatWidth(layout: Layout): number {
  const drawer = useBrowserDrawerStore.getState();
  const appSidebarCollapsed = (useSettingsStore.getState().settings.sidebarCollapsed ?? false) || drawer.appSidebarCollapsedByDrawer;
  const history = useInsightsStore.getState().chatHistoryOpen ? CHAT_HISTORY_WIDTH : 0;
  const drawerWidth = layout.open ? clampDrawerWidth(layout.width, layout.windowWidth, layout.chatMinWidth) : 0;
  return layout.windowWidth - drawerWidth - (appSidebarCollapsed ? APP_SIDEBAR_COLLAPSED_WIDTH : APP_SIDEBAR_WIDTH) - history;
}

export function useChatRoom(): void {
  useEffect(() => {
    const layout = (): Layout => {
      const { open, width, chatMinWidth } = useBrowserDrawerStore.getState();
      return { open, width, chatMinWidth, windowWidth: window.innerWidth };
    };
    /**
     * The layout as the last change left it: which way it moved decides what may close or open.
     * It starts closed, so a page showing with the drawer open makes room at once
     */
    let last: Layout = { ...layout(), open: false };

    const adjust = () => {
      const now = layout();
      // A window with no width yet (minimizing on some platforms) says nothing about the room
      if (now.windowWidth <= 0) return;
      const before = last;
      last = now;
      const lessRoom = now.width > before.width || now.chatMinWidth > before.chatMinWidth || now.windowWidth < before.windowWidth;
      const moreRoom = now.width < before.width || now.chatMinWidth < before.chatMinWidth || now.windowWidth > before.windowWidth;
      const grew = now.open && (!before.open || lessRoom);
      const shrank = now.open ? before.open && moreRoom : before.open;
      if (!grew && !shrank) return;

      let width = chatWidth(now);
      const minWidth = now.chatMinWidth;
      const insights = useInsightsStore.getState();
      const drawer = useBrowserDrawerStore.getState();
      const appSidebarSaved = useSettingsStore.getState().settings.sidebarCollapsed ?? false;

      if (grew && width < minWidth) {
        if (insights.chatHistoryOpen) {
          drawer.setHistoryClosedByDrawer(true);
          insights.setChatHistoryOpen(false, false);
          width += CHAT_HISTORY_WIDTH;
        }
        if (width < minWidth && !appSidebarSaved && !drawer.appSidebarCollapsedByDrawer) drawer.setAppSidebarCollapsedByDrawer(true);
        return;
      }
      if (!shrank) return;
      if (drawer.appSidebarCollapsedByDrawer) {
        if (width - APP_SIDEBAR_COLLAPSE_GAIN < minWidth) return;
        drawer.setAppSidebarCollapsedByDrawer(false);
        width -= APP_SIDEBAR_COLLAPSE_GAIN;
      }
      if (!insights.chatHistoryOpen && drawer.historyClosedByDrawer && width - CHAT_HISTORY_WIDTH >= minWidth) {
        drawer.setHistoryClosedByDrawer(false);
        insights.setChatHistoryOpen(true, false);
      }
    };

    // The drawer's changes and the window's only: not the sidebars', so the user's toggles stay
    const unsubscribe = useBrowserDrawerStore.subscribe((state, previous) => {
      if (state.open !== previous.open || state.width !== previous.width || state.chatMinWidth !== previous.chatMinWidth) adjust();
    });
    window.addEventListener('resize', adjust);
    adjust();
    return () => {
      unsubscribe();
      window.removeEventListener('resize', adjust);
    };
  }, []);
}
