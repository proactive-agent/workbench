/**
 * @vitest-environment jsdom
 */
/**
 * Browser page (Settings > Browser): the default profile (kept with the connector defaults), the
 * homepage a chat's browser opens and the bookmarks bar switch.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import type { AppSettings } from '../../../../shared/types';
import type { PlaywrightBrowserChoice } from '../../../../shared/types/browser-profiles';

const firefox = { id: 'firefox:x', browser: 'firefox', engine: 'firefox' } as PlaywrightBrowserChoice;

vi.mock('../../../hooks/useMcpAvailability', () => ({ useMcpUnavailableReason: () => () => undefined }));
vi.mock('../PlaywrightBrowserSelect', () => ({
  PlaywrightBrowserSelect: ({ onChange }: { onChange: (choice: PlaywrightBrowserChoice | null) => void }) => (
    <button type="button" onClick={() => onChange(firefox)}>pick firefox</button>
  ),
}));

import { BrowserSettings } from '../BrowserSettings';

const renderPage = (settings: Partial<AppSettings>) => {
  const onSettingsChange = vi.fn();
  render(<BrowserSettings settings={settings as AppSettings} onSettingsChange={onSettingsChange} />);
  return { onSettingsChange };
};

describe('BrowserSettings', () => {
  it('keeps the default profile with the connector defaults', () => {
    const { onSettingsChange } = renderPage({ mcpConnectors: { playwrightEnabled: true } });
    fireEvent.click(screen.getByText('pick firefox'));
    expect(onSettingsChange).toHaveBeenCalledWith({ mcpConnectors: { playwrightEnabled: true, playwrightBrowser: firefox } });
  });

  it('saves the homepage as an address once typed, and an empty one as none', () => {
    const { onSettingsChange } = renderPage({ browser: { homepage: 'https://old.test/' } });
    const input = screen.getByLabelText('Homepage');
    fireEvent.change(input, { target: { value: 'start.test' } });
    fireEvent.blur(input);
    expect(onSettingsChange).toHaveBeenLastCalledWith({ browser: { homepage: 'https://start.test' } });
    expect(input).toHaveValue('https://start.test');

    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSettingsChange).toHaveBeenLastCalledWith({ browser: { homepage: undefined } });
  });

  it('shows the bookmarks bar by default and turns it off', () => {
    const { onSettingsChange } = renderPage({});
    const toggle = screen.getByRole('switch', { name: 'Show bookmarks bar' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onSettingsChange).toHaveBeenCalledWith({ browser: { showBookmarksBar: false } });
  });
});
