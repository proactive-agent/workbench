/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatBrowserStart } from '../ChatBrowserStart';
import { useBrowserDrawerStore } from '../../../stores/browser-drawer-store';
import type { ChatBrowserRequirements } from '../../../../shared/types/browser-drawer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../settings/PlaywrightBrowserSelect', () => ({ PlaywrightBrowserSelect: () => <div>picker</div> }));
vi.mock('../../../hooks/useMcpAvailability', () => ({ useMcpUnavailableReason: () => () => null }));

let changed: ((change: { configuring: boolean }) => void) | null = null;
const api = {
  getChatBrowserRequirements: vi.fn(async (): Promise<{ success: boolean; data: ChatBrowserRequirements }> => ({
    success: true,
    data: { missing: ['node', 'browserBuild'], build: 'chromium' },
  })),
  autoconfigureChatBrowser: vi.fn(async () => ({ success: true, data: { missing: ['node', 'browserBuild'], build: 'chromium', configuring: true } })),
  onChatBrowserRequirementsChanged: vi.fn((listener: (change: { configuring: boolean }) => void) => {
    changed = listener;
    return () => {
      changed = null;
    };
  }),
  openChatBrowser: vi.fn(async () => ({ success: true })),
};

describe('ChatBrowserStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: typeof api }).electronAPI = api;
    useBrowserDrawerStore.setState({ openErrors: {} });
  });

  it('offers Autoconfigure, saying what it installs, while opening the browser needs something missing', async () => {
    render(<ChatBrowserStart projectId="app" chatId="new" />);

    const button = await screen.findByRole('button', { name: 'navigation:browserDrawer.setup.autoconfigure' });
    expect(screen.queryByRole('button', { name: 'navigation:browserDrawer.openBrowser' })).not.toBeInTheDocument();
    expect(screen.getByText(/navigation:browserDrawer\.setup\.description/)).toHaveTextContent('navigation:browserDrawer.setup.and');

    fireEvent.click(button);
    await screen.findByText('navigation:browserDrawer.setup.configuring');
    expect(api.autoconfigureChatBrowser).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole('button', { name: 'navigation:browserDrawer.setup.installing' })).toBeDisabled();

    // The PowerShell window closed with everything installed: the browser can open
    api.getChatBrowserRequirements.mockResolvedValue({ success: true, data: { missing: [], build: 'chromium' } });
    await act(async () => changed?.({ configuring: false }));
    expect(await screen.findByRole('button', { name: 'navigation:browserDrawer.openBrowser' })).toBeEnabled();
    expect(screen.queryByText(/navigation:browserDrawer\.setup\.description/)).not.toBeInTheDocument();
  });

  it("keeps a failed open's error across the loader, and asks what is missing again when told", async () => {
    api.getChatBrowserRequirements.mockResolvedValue({ success: true, data: { missing: [] } });
    api.openChatBrowser.mockResolvedValueOnce({ success: false, error: "Node.js isn't installed on Windows" } as never);
    const { unmount } = render(<ChatBrowserStart projectId="app" chatId="new" />);
    fireEvent.click(await screen.findByRole('button', { name: 'navigation:browserDrawer.openBrowser' }));
    // The drawer shows its loader while the browser starts: the empty state goes, then comes back
    unmount();
    await act(async () => undefined);
    api.getChatBrowserRequirements.mockResolvedValue({ success: true, data: { missing: ['node'] } });
    render(<ChatBrowserStart projectId="app" chatId="new" />);
    expect(await screen.findByText(/Node\.js isn't installed on Windows/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'navigation:browserDrawer.setup.autoconfigure' })).toBeInTheDocument();
  });
});
