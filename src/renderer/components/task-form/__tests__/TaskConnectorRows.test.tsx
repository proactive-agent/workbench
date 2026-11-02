/**
 * @vitest-environment jsdom
 */
/**
 * A task's connectors: read-only in the task view, and the Puppeteer row's browser profile for the
 * task (the one in Settings until another is picked)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import '../../../../shared/i18n';
import { TaskConnectorRows } from '../TaskConnectorRows';
import { useSettingsStore } from '../../../stores/settings-store';
import { toBrowserChoice } from '../../settings/browser-profile-meta';
import type { BrowserProfile } from '../../../../shared/types/browser-profiles';

const chrome: BrowserProfile = {
  id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Home',
  userDataDir: '/home/me/.config/google-chrome', profileDirectory: 'Default', profilePath: '/home/me/.config/google-chrome/Default',
  executablePath: '/opt/google/chrome/chrome', usable: true,
};
const firefox: BrowserProfile = {
  id: 'firefox:work', browser: 'firefox', engine: 'firefox', profileName: 'Work',
  userDataDir: '/home/me/.mozilla/firefox', profilePath: '/home/me/.mozilla/firefox/work',
  executablePath: '/usr/lib/firefox/firefox', usable: true,
};

describe('TaskConnectorRows', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      // Every server is ready
      getMcpAvailability: vi.fn(async (ids: string[]) => ({
        success: true,
        data: Object.fromEntries(ids.map((id) => [id, { state: 'ready' }])),
      })),
      onMcpAvailabilityChanged: vi.fn(() => () => undefined),
      detectBrowserProfiles: vi.fn(async () => ({ success: true, data: [chrome, firefox] })),
      onBrowserProfilesChanged: vi.fn(() => () => undefined),
      installPuppeteerBrowser: vi.fn(async () => undefined),
    };
    const { settings } = useSettingsStore.getState();
    useSettingsStore.setState({
      settings: { ...settings, mcpConnectors: { puppeteerEnabled: true, puppeteerBrowser: toBrowserChoice(chrome) } },
    });
  });

  it("shows the task's connectors and browser without letting them change", async () => {
    const { getByRole, getByText, queryByRole } = render(
      <TaskConnectorRows value={['puppeteer']} puppeteerBrowser={toBrowserChoice(firefox)} readOnly />
    );
    const puppeteer = getByRole('switch', { name: 'Puppeteer' });
    expect(puppeteer.getAttribute('aria-checked')).toBe('true');
    expect(puppeteer.hasAttribute('disabled')).toBe(true);
    expect(getByRole('switch', { name: 'Context7' }).getAttribute('aria-checked')).toBe('false');
    // The task's own browser, as text: no picker
    expect(getByText('Firefox · Work')).toBeTruthy();
    expect(queryByRole('combobox')).toBeNull();
  });

  it('shows the Settings browser in the task view when the task picked none', () => {
    const { getByText } = render(<TaskConnectorRows value={['puppeteer']} readOnly />);
    expect(getByText('Chrome · Home')).toBeTruthy();
  });

  it("starts from the Settings browser and stores only the task's own pick", async () => {
    const onPick = vi.fn();
    const { getByRole, findByRole } = render(
      <TaskConnectorRows value={['puppeteer']} onChange={vi.fn()} onPuppeteerBrowserChange={onPick} />
    );
    await waitFor(() => expect(window.electronAPI.detectBrowserProfiles).toHaveBeenCalled());
    expect(getByRole('combobox').textContent).toContain('Chrome · Home');
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    // The Settings profile again is no choice of the task's
    fireEvent.click(await findByRole('option', { name: /Chrome · Home/ }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(await findByRole('option', { name: /Puppeteer's Chrome/ }));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('keeps the browser picker in the form while Puppeteer is off for the task', () => {
    const { getByRole } = render(
      <TaskConnectorRows value={['context7']} onChange={vi.fn()} onPuppeteerBrowserChange={vi.fn()} />
    );
    expect(getByRole('combobox')).toBeTruthy();
  });

  it('names no browser in the task view while Puppeteer is off for the task', () => {
    const { queryByTitle } = render(<TaskConnectorRows value={['context7']} readOnly />);
    expect(queryByTitle(/browser/i)).toBeNull();
  });
});
