/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '../../ui/tooltip';
import { BrowserDrawer } from '../BrowserDrawer';
import { useBrowserDrawerStore } from '../../../stores/browser-drawer-store';
import type { BrowserBookmark } from '../../../../shared/types/browser-drawer';

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
};

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
    expect(api.viewBrowserPage).toHaveBeenCalledWith('p1', 700, 500, 1);

    fireEvent.click(screen.getByText('other.test/a'));
    expect(useBrowserDrawerStore.getState().selectedPageId).toBe('p2');

    fireEvent.change(screen.getByLabelText('browserDrawer.address'), { target: { value: 'example.com' } });
    fireEvent.submit(screen.getByLabelText('browserDrawer.address').closest('form')!);
    expect(api.navigateBrowserPage).toHaveBeenCalledWith('p2', 'goto', 'https://example.com');

    fireEvent.click(screen.getByRole('button', { name: 'browserDrawer.close' }));
    expect(useBrowserDrawerStore.getState().open).toBe(false);
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
});
