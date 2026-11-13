/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '../../ui/tooltip';
import { BrowserDrawer } from '../BrowserDrawer';
import { useBrowserDrawerStore } from '../../../stores/browser-drawer-store';
import { useSettingsStore } from '../../../stores/settings-store';
import type { BrowserBookmark, BrowserExtensions } from '../../../../shared/types/browser-drawer';
import type { BrowserShortcut } from '../../../../shared/utils/browser-shortcuts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const api = {
  subscribeBrowserDrawer: vi.fn(async () => ({ success: true })),
  unsubscribeBrowserDrawer: vi.fn(async () => ({ success: true })),
  viewBrowserPage: vi.fn(),
  sendBrowserInput: vi.fn(),
  browserFrameDrawn: vi.fn(),
  navigateBrowserPage: vi.fn(),
  closeBrowserPage: vi.fn(),
  onBrowserFrame: vi.fn(() => () => {}),
  setBrowserColorScheme: vi.fn(),
  getBrowserBookmarks: vi.fn(async (_sessionId: string) => ({ success: true, data: [] as BrowserBookmark[] })),
  getBrowserExtensions: vi.fn(async (_sessionId: string, _switches?: Record<string, boolean>) => ({ success: true, data: null as BrowserExtensions | null })),
  restartChatBrowser: vi.fn(async (_sessionId: string) => ({ success: true })),
  runBrowserExtension: vi.fn(async (_pageId: string, _extensionId: string, _name: string) => ({ success: true, data: {} })),
  saveSettings: vi.fn(async (_settings: unknown) => ({ success: true })),
  newBrowserPage: vi.fn(),
  setBrowserShortcuts: vi.fn(),
  onBrowserShortcut: vi.fn((listener: (shortcut: BrowserShortcut) => void) => {
    shortcutListener = listener;
    return () => {
      if (shortcutListener === listener) shortcutListener = null;
    };
  }),
};
let shortcutListener: ((shortcut: BrowserShortcut) => void) | null = null;

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

describe('BrowserDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: typeof api }).electronAPI = api;
    (globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver }).ResizeObserver = FakeResizeObserver;
    // The page area's size (jsdom has no layout)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700.6, height: 500.2, top: 0, left: 0, right: 700, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    useBrowserDrawerStore.setState({
      bookmarks: {},
      extensions: {},
      open: false,
      selectedPageId: 'p1',
      state: {
        available: true,
        sessions: [{ id: 's', title: 'claude-code', browserName: 'chromium', projectId: 'app' }],
        pages: [
          { id: 'p1', sessionId: 's', title: 'Docs', url: 'https://docs.test/' },
          { id: 'p2', sessionId: 's', title: '', url: 'https://other.test/a' },
        ],
      },
    });
  });

  const renderDrawer = () => render(<TooltipProvider><BrowserDrawer projectId="app" /></TooltipProvider>);

  it('shows nothing while closed (the Claude chat\'s top bar opens it), and no handle', () => {
    const { container } = renderDrawer();
    expect(container).toBeEmptyDOMElement();
    expect(api.subscribeBrowserDrawer).not.toHaveBeenCalled();
  });

  it('shows the pages as tabs above the toolbar and the chosen page', () => {
    useBrowserDrawerStore.setState({ open: true });
    renderDrawer();
    expect(api.subscribeBrowserDrawer).toHaveBeenCalled();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Docs', 'other.test/a']);
    expect(screen.getByLabelText('browserDrawer.address')).toHaveValue('https://docs.test/');
    // The page's viewport is the page area, in whole pixels, its frames at the window's density
    expect(api.viewBrowserPage).toHaveBeenCalledWith('p1', 700, 500, 1, false);

    fireEvent.click(screen.getByText('other.test/a'));
    expect(useBrowserDrawerStore.getState().selectedPageId).toBe('p2');

    fireEvent.change(screen.getByLabelText('browserDrawer.address'), { target: { value: 'example.com' } });
    fireEvent.submit(screen.getByLabelText('browserDrawer.address').closest('form')!);
    expect(api.navigateBrowserPage).toHaveBeenCalledWith('p2', 'goto', 'https://example.com');

    // No chat browser here: it only hides the drawer
    fireEvent.click(screen.getByRole('button', { name: 'browserDrawer.hide' }));
    expect(useBrowserDrawerStore.getState().open).toBe(false);
  });

  it("acts on the browser's shortcuts while it shows a tab (the main process catches them)", () => {
    const { unmount } = renderDrawer();
    // Closed: the keys are the app's
    expect(api.setBrowserShortcuts).not.toHaveBeenCalledWith(true);
    act(() => useBrowserDrawerStore.setState({ open: true }));
    expect(api.setBrowserShortcuts).toHaveBeenLastCalledWith(true);
    const press = (shortcut: BrowserShortcut) => act(() => shortcutListener?.(shortcut));

    press({ kind: 'nextTab' });
    expect(useBrowserDrawerStore.getState().selectedPageId).toBe('p2');
    press({ kind: 'nextTab' });
    expect(useBrowserDrawerStore.getState().selectedPageId).toBe('p1');
    press({ kind: 'previousTab' });
    expect(useBrowserDrawerStore.getState().selectedPageId).toBe('p2');
    press({ kind: 'tab', index: 0 });
    expect(useBrowserDrawerStore.getState().selectedPageId).toBe('p1');
    press({ kind: 'tab', index: -1 });
    expect(useBrowserDrawerStore.getState().selectedPageId).toBe('p2');
    // A tab that isn't there
    press({ kind: 'tab', index: 5 });
    expect(useBrowserDrawerStore.getState().selectedPageId).toBe('p2');

    press({ kind: 'reload' });
    expect(api.navigateBrowserPage).toHaveBeenLastCalledWith('p2', 'reload');
    press({ kind: 'back' });
    expect(api.navigateBrowserPage).toHaveBeenLastCalledWith('p2', 'back');
    press({ kind: 'address' });
    expect(screen.getByLabelText('browserDrawer.address')).toHaveFocus();
    press({ kind: 'newTab' });
    expect(api.newBrowserPage).toHaveBeenCalledWith('s');
    press({ kind: 'closeTab' });
    expect(api.closeBrowserPage).toHaveBeenCalledWith('p2');

    unmount();
    expect(api.setBrowserShortcuts).toHaveBeenLastCalledWith(false);
  });

  it("shows the browser profile's bookmarks bar, opening a bookmark in the tab shown", async () => {
    api.getBrowserBookmarks.mockResolvedValueOnce({
      success: true,
      data: [{ title: 'Mail', url: 'https://mail.test/' }, { title: 'Work', children: [] }],
    });
    useBrowserDrawerStore.setState({ open: true });
    renderDrawer();
    expect(api.getBrowserBookmarks).toHaveBeenCalledWith('s');
    fireEvent.click(await screen.findByRole('button', { name: 'Mail' }));
    expect(api.navigateBrowserPage).toHaveBeenCalledWith('p1', 'goto', 'https://mail.test/');
    expect(screen.getByRole('button', { name: 'Work' })).toBeInTheDocument();
  });

  const chatSession = () => useBrowserDrawerStore.setState((s) => ({
    open: true,
    state: { ...s.state, sessions: [{ id: 's', title: 'Workbench chat 1', browserName: 'chromium', projectId: 'app', chatId: 'c1' }] },
  }));
  const listed = (ublock: boolean, more: Partial<BrowserExtensions> = {}): BrowserExtensions => ({
    browserId: 'chrome:Default',
    extensions: [
      { id: 'dr', name: 'Dark Reader', enabled: true, pinned: true, icon: 'data:image/png;base64,AA==' },
      { id: 'ub', name: 'uBlock Origin', enabled: ublock, pinned: false },
    ],
    canOpen: true,
    ...more,
  });

  it("shows the pinned extensions in the toolbar and the others in a list: a click opens one, its switch turns it off", async () => {
    api.getBrowserExtensions.mockResolvedValue({ success: true, data: listed(true) });
    chatSession();
    renderDrawer();
    expect(api.getBrowserExtensions).toHaveBeenCalledWith('s');
    // A pinned one opens for the tab shown, as the browser's button does
    fireEvent.click(await screen.findByRole('button', { name: 'Dark Reader' }));
    expect(api.runBrowserExtension).toHaveBeenCalledWith('p1', 'dr', 'Dark Reader');

    fireEvent.keyDown(screen.getByRole('button', { name: 'browserDrawer.extensions' }), { key: 'Enter' });
    const row = await screen.findByRole('menuitem', { name: /uBlock Origin/ });
    // Pinned ones aren't listed
    expect(screen.queryByRole('menuitem', { name: /Dark Reader/ })).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(api.runBrowserExtension).toHaveBeenCalledWith('p1', 'ub', 'uBlock Origin');
    expect(api.getBrowserExtensions).not.toHaveBeenCalledWith('s', expect.anything());

    // Only the switch turns it off, kept in Settings for the profile
    fireEvent.keyDown(screen.getByRole('button', { name: 'browserDrawer.extensions' }), { key: 'Enter' });
    api.getBrowserExtensions.mockResolvedValue({ success: true, data: listed(false) });
    api.runBrowserExtension.mockClear();
    fireEvent.click(await screen.findByRole('switch', { name: 'browserDrawer.extensionSwitch' }));
    await vi.waitFor(() => expect(api.getBrowserExtensions).toHaveBeenCalledWith('s', { ub: false }));
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      browser: expect.objectContaining({ extensionSwitches: { 'chrome:Default': { ub: false } } }),
    }));
    expect(api.runBrowserExtension).not.toHaveBeenCalled();
  });

  it("offers to restart a browser that switches its extensions at start, and opens none it can't", async () => {
    api.getBrowserExtensions.mockResolvedValue({ success: true, data: listed(false, { canOpen: false, restartToApply: true }) });
    chatSession();
    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: 'Dark Reader' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'browserDrawer.extensions' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /uBlock Origin/ }));
    expect(api.runBrowserExtension).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('menuitem', { name: /browserDrawer.restartBrowser/ }));
    expect(api.restartChatBrowser).toHaveBeenCalledWith('s');
  });

  it("shows an extension's popup over the tab it opened for, closed by a click beside it", () => {
    useBrowserDrawerStore.setState((s) => ({
      open: true,
      state: {
        ...s.state,
        pages: [
          ...s.state.pages,
          { id: 'pop', sessionId: 's', title: 'uBlock Origin', url: 'chrome-extension://ub/popup.html', popup: { extensionId: 'ub', openerId: 'p1', width: 320, height: 200 } },
        ],
      },
    }));
    const { container } = renderDrawer();
    // Not a tab
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(api.viewBrowserPage).toHaveBeenCalledWith('pop', 700, 500, 1, true);
    fireEvent.pointerDown(container.querySelector('[aria-hidden].absolute.inset-0')!);
    expect(api.closeBrowserPage).toHaveBeenCalledWith('pop');
  });

  it('shows no extensions for a browser that runs none', async () => {
    api.getBrowserExtensions.mockResolvedValue({ success: true, data: null });
    useBrowserDrawerStore.setState((s) => ({
      open: true,
      state: { ...s.state, sessions: [{ id: 's', title: 'Workbench chat 1', browserName: 'firefox', projectId: 'app', chatId: 'c1' }] },
    }));
    renderDrawer();
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: 'browserDrawer.extensions' })).not.toBeInTheDocument();
  });

  it('leaves the bookmarks bar out when Settings > Browser turns it off', async () => {
    api.getBrowserBookmarks.mockResolvedValue({ success: true, data: [{ title: 'Mail', url: 'https://mail.test/' }] });
    const previous = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...previous, browser: { showBookmarksBar: false } } });
    try {
      useBrowserDrawerStore.setState({ open: true });
      renderDrawer();
      await Promise.resolve();
      expect(screen.queryByRole('toolbar', { name: 'browserDrawer.bookmarks' })).not.toBeInTheDocument();
      expect(api.getBrowserBookmarks).not.toHaveBeenCalled();
    } finally {
      useSettingsStore.setState({ settings: previous });
      api.getBrowserBookmarks.mockResolvedValue({ success: true, data: [] });
    }
  });
});
