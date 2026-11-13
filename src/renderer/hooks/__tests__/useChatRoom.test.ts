/**
 * @vitest-environment jsdom
 *
 * The chat keeps the width its composer needs beside the browser drawer: the history closes, then
 * the app's sidebar collapses, as the drawer takes the room (or the chat needs more, or the page
 * shows with the drawer open), and they open again the other way round, only what the drawer
 * closed. The chat's width comes from the layout's state (window 1600, app's sidebar 288 or 56,
 * history 256), never from the page
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChatRoom } from '../useChatRoom';
import { useBrowserDrawerStore } from '../../stores/browser-drawer-store';
import { APP_SIDEBAR_COLLAPSED_WIDTH, APP_SIDEBAR_WIDTH, CHAT_HISTORY_WIDTH } from '../../lib/layout-widths';
import { useInsightsStore } from '../../stores/insights-store';

const setWindowWidth = (width: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
const drawer = () => useBrowserDrawerStore.getState();
const historyOpen = () => useInsightsStore.getState().chatHistoryOpen;

/** The drawer at its widest (1044: the chat keeps 500 beside the collapsed sidebar), having closed both */
function squeezed() {
  useBrowserDrawerStore.setState({ open: true, width: 1044, historyClosedByDrawer: true, appSidebarCollapsedByDrawer: true });
  useInsightsStore.setState({ chatHistoryOpen: false });
}

describe('useChatRoom', () => {
  beforeEach(() => {
    setWindowWidth(1600);
    useBrowserDrawerStore.setState({ open: false, width: 600, chatMinWidth: 500, appSidebarCollapsedByDrawer: false, historyClosedByDrawer: false });
    useInsightsStore.setState({ chatHistoryOpen: true });
  });

  it('closes the history, then collapses the sidebar as the drawer widens, and opens them again as it narrows', () => {
    renderHook(() => useChatRoom());

    // 1600 - 288 - 256 - 600 = 456 < 500: the history goes
    act(() => useBrowserDrawerStore.setState({ open: true }));
    expect(historyOpen()).toBe(false);
    expect(drawer().appSidebarCollapsedByDrawer).toBe(false);

    // 1600 - 288 - 900 = 412 < 500: the sidebar collapses too
    act(() => useBrowserDrawerStore.setState({ width: 900 }));
    expect(drawer().appSidebarCollapsedByDrawer).toBe(true);

    // Narrower again: the sidebar first, then the history, each once the chat keeps its width
    act(() => useBrowserDrawerStore.setState({ width: 700 }));
    expect(drawer().appSidebarCollapsedByDrawer).toBe(false);
    expect(historyOpen()).toBe(false);
    act(() => useBrowserDrawerStore.setState({ open: false }));
    expect(historyOpen()).toBe(true);
  });

  it('makes room when the page shows with the drawer open', () => {
    useBrowserDrawerStore.setState({ open: true, width: 900 });
    renderHook(() => useChatRoom());
    expect(historyOpen()).toBe(false);
    expect(drawer().appSidebarCollapsedByDrawer).toBe(true);
  });

  it('makes room when the chat needs more (more composer buttons), and leaves a history the user closed', () => {
    useInsightsStore.setState({ chatHistoryOpen: false });
    useBrowserDrawerStore.setState({ open: true, width: 700 });
    renderHook(() => useChatRoom());

    // 1600 - 288 - 700 = 612: enough until the chat needs 650
    act(() => drawer().setChatMinWidth(650));
    expect(drawer().appSidebarCollapsedByDrawer).toBe(true);

    act(() => drawer().setChatMinWidth(500));
    expect(drawer().appSidebarCollapsedByDrawer).toBe(false);
    expect(historyOpen()).toBe(false);
  });

  it('keeps the sidebar collapsed when the user opens the history again (the drawer gives up its room)', () => {
    squeezed();
    renderHook(() => useChatRoom());
    // As the history toggle does it: shown first, then the drawer narrows by its width
    act(() => {
      drawer().setHistoryClosedByDrawer(false);
      useInsightsStore.getState().setChatHistoryOpen(true);
      drawer().narrowBy(CHAT_HISTORY_WIDTH);
    });
    expect(historyOpen()).toBe(true);
    expect(drawer().appSidebarCollapsedByDrawer).toBe(true);
    expect(drawer().width).toBe(1044 - CHAT_HISTORY_WIDTH);
  });

  it('keeps the history closed when the user expands the sidebar again (the drawer gives up its room)', () => {
    squeezed();
    renderHook(() => useChatRoom());
    // As the sidebar's toggle does it
    act(() => {
      drawer().setAppSidebarCollapsedByDrawer(false);
      drawer().narrowBy(APP_SIDEBAR_WIDTH - APP_SIDEBAR_COLLAPSED_WIDTH);
    });
    expect(drawer().appSidebarCollapsedByDrawer).toBe(false);
    expect(historyOpen()).toBe(false);
    expect(drawer().historyClosedByDrawer).toBe(true);
  });

  it('ignores a window without a width', () => {
    useBrowserDrawerStore.setState({ open: true, width: 600 });
    useInsightsStore.setState({ chatHistoryOpen: false });
    renderHook(() => useChatRoom());
    act(() => {
      setWindowWidth(0);
      window.dispatchEvent(new Event('resize'));
    });
    expect(drawer().appSidebarCollapsedByDrawer).toBe(false);
  });
});
