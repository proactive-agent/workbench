/**
 * @vitest-environment jsdom
 */
/**
 * Tests for UsageIndicator (sidebar usage badge and breakdown)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UsageIndicator, USAGE_LOADING_TIMEOUT_MS } from './UsageIndicator';
import { useSettingsStore } from '../stores/settings-store';

vi.mock('../stores/settings-store', () => ({
  useSettingsStore: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: vi.fn(() => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'common:usage.loading': 'Loading...',
        'common:usage.usageBreakdown': 'Usage',
        'common:usage.apiKeyBadge': 'API key',
        'common:usage.invalidKeyBadge': 'Invalid key',
        'common:usage.apiKeyInvalid': '{{provider}} rejected this API key',
        'common:usage.noUsageMonitoring': 'Usage monitoring not available',
        'common:usage.subscriptionBadge': 'Subscription',
        'common:usage.subscriptionLimitsApply': 'Rate limits apply',
        'common:usage.subscriptionMonitoringComingSoon': 'Monitoring not available',
        'common:usage.dataUnavailable': 'Usage data unavailable',
        'common:usage.dataUnavailableDescription': 'Usage data is unavailable',
        'common:usage.crossProviderUsage': 'Cross-Provider Usage',
        'common:usage.crossProvider': 'Cross-Provider',
        'common:usage.swap': 'Swap',
        'common:usage.inUse': 'In Use',
        'common:usage.otherAccounts': 'Other Accounts',
        'common:usage.activeAccount': 'Active Account',
        'common:usage.providerAnthropic': 'Anthropic',
        'common:usage.providerOpenAI': 'OpenAI',
        'common:usage.providerGoogle': 'Google AI',
        'common:usage.weekAllModels': 'Week',
        'common:usage.weekScoped': '{{model}} · Week',
        'common:usage.compactHours': '{{hours}}h {{minutes}}m',
        'common:usage.compactDays': '{{days}}d {{hours}}h',
        'common:usage.resetsInLowerHours': 'resets in {{hours}}h {{minutes}}m',
        'common:usage.resetsInLowerDays': 'resets in {{days}}d {{hours}}h',
        'common:usage.spendOfLimit': '{{used}} of {{limit}} this month',
      };

      if (params && Object.keys(params).length > 0) {
        const translated = translations[key] || key;
        return translated.replace(/{{(\w+)}}/g, (whole, name) =>
          name in params ? String(params[name]) : whole);
      }

      return translations[key] || key;
    },
    i18n: {
      language: 'en',
    },
  })),
}));

const apiProfile = {
  id: 'api-1',
  name: 'Gateway',
  baseUrl: 'https://gateway.example.com/v1',
  apiKey: 'sk-test-1234',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

/** Settings store state: an API profile is in use only when activeProfileId is set */
function mockStore(activeProfileId: string | null) {
  const state = { profiles: [apiProfile], activeProfileId, settings: {} };
  vi.mocked(useSettingsStore).mockImplementation(((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as any);
}

describe('UsageIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (window as any).electronAPI = {
      onUsageUpdated: vi.fn(() => vi.fn()),
      requestUsageUpdate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          profileId: 'account-openai',
          profileName: 'OpenAI API',
          profileEmail: 'openai@example.com',
          sessionPercent: 45,
          weeklyPercent: 55,
          sessionResetTimestamp: '2026-03-04T12:00:00.000Z',
          weeklyResetTimestamp: '2026-03-11T12:00:00.000Z',
          fetchedAt: new Date(),
          needsReauthentication: false,
        },
      }),
      requestAllProfilesUsage: vi.fn().mockResolvedValue({
        success: true,
        data: {
          allProfiles: [
            {
              profileId: 'account-anthropic',
              profileName: 'Anthropic OAuth',
              sessionPercent: 70,
              weeklyPercent: 80,
              isAuthenticated: true,
              isRateLimited: false,
              availabilityScore: 20,
              isActive: false,
            },
          ],
          activeProfile: {
            profileId: 'account-openai',
            profileName: 'OpenAI API',
            profileEmail: 'openai@example.com',
            sessionPercent: 45,
            weeklyPercent: 55,
            isActive: true,
          },
        },
      }),
      onAllProfilesUsageUpdated: vi.fn(),
    };
  });

  describe('usage breakdown', () => {
    beforeEach(() => {
      // Claude account in use (usage monitoring available)
      mockStore(null);
    });

    it('shows the session and weekly usage in the badge', async () => {
      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      await waitFor(() => expect(usageTrigger).toHaveTextContent('45'));
      expect(usageTrigger).toHaveTextContent('55');
    });

    it('follows an account switch pushed by the main process right away', async () => {
      let push: (usage: unknown) => void = () => {};
      (window as any).electronAPI.onUsageUpdated = vi.fn((callback: (usage: unknown) => void) => {
        push = callback;
        return vi.fn();
      });
      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      await waitFor(() => expect(usageTrigger).toHaveTextContent('45'));

      // Switched to an account with stored usage: its numbers, not the previous account's
      act(() => push({ profileId: 'work', profileName: 'Work', sessionPercent: 12, weeklyPercent: 34, fetchedAt: new Date() }));
      expect(usageTrigger).toHaveTextContent('12');
      expect(usageTrigger).toHaveTextContent('34');
      expect(usageTrigger).not.toHaveTextContent('45');

      // Switched to an account whose usage was never fetched: waits for it
      act(() => push(null));
      expect(screen.getByText('Loading...')).toBeInTheDocument();
      expect(screen.queryByText('34')).not.toBeInTheDocument();
    });

    it('stops showing Loading when the new account\'s usage never arrives', async () => {
      let push: (usage: unknown) => void = () => {};
      (window as any).electronAPI.onUsageUpdated = vi.fn((callback: (usage: unknown) => void) => {
        push = callback;
        return vi.fn();
      });
      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      await waitFor(() => expect(usageTrigger).toHaveTextContent('45'));

      vi.useFakeTimers();
      try {
        act(() => push(null));
        expect(screen.getByText('Loading...')).toBeInTheDocument();
        act(() => { vi.advanceTimersByTime(USAGE_LOADING_TIMEOUT_MS); });
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('leads with the 5-hour limit and lists the week, without other accounts', async () => {
      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      fireEvent.click(usageTrigger);

      expect(await screen.findByText('Usage')).toBeInTheDocument();
      // The 5-hour limit is the big number at the top, with "%" set apart from it
      const breakdown = within(screen.getByRole('dialog'));
      expect(breakdown.getByText('45')).toBeInTheDocument();
      expect(screen.getByText('Week')).toBeInTheDocument();
      expect(screen.getByText('55%')).toBeInTheDocument();
      expect(screen.queryByText('common:usage.otherAccounts')).not.toBeInTheDocument();
      expect(screen.queryByText('OpenAI OAuth')).not.toBeInTheDocument();
      expect(screen.queryByText('Cross-Provider Usage')).not.toBeInTheDocument();
    });

    it('hides the Fable row when the provider does not report that limit', async () => {
      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      fireEvent.click(usageTrigger);

      expect(await screen.findByText('Usage')).toBeInTheDocument();
      expect(screen.queryByText('Fable · Week')).not.toBeInTheDocument();
    });

    it('shows the Fable weekly limit when it is reported', async () => {
      (window as any).electronAPI.requestUsageUpdate = vi.fn().mockResolvedValue({
        success: true,
        data: {
          profileId: 'account-anthropic',
          profileName: 'Anthropic',
          sessionPercent: 45,
          weeklyPercent: 55,
          fablePercent: 18,
          sessionResetTimestamp: '2026-03-04T12:00:00.000Z',
          weeklyResetTimestamp: '2026-03-11T12:00:00.000Z',
          fableResetTimestamp: '2026-03-11T12:00:00.000Z',
          fetchedAt: new Date(),
          needsReauthentication: false,
        },
      });

      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      fireEvent.click(usageTrigger);

      expect(await screen.findByText('Fable · Week')).toBeInTheDocument();
      expect(screen.getByText('18%')).toBeInTheDocument();
    });

    it("shows an Enterprise account's monthly spend limit instead of the 5-hour and weekly windows", async () => {
      (window as any).electronAPI.requestUsageUpdate = vi.fn().mockResolvedValue({
        success: true,
        data: {
          profileId: 'account-enterprise',
          profileName: 'Enterprise',
          sessionPercent: 54.488,
          weeklyPercent: 54.488,
          spendLimit: { used: 136.22, limit: 250, currency: 'USD' },
          fetchedAt: new Date(),
          needsReauthentication: false,
        },
      });

      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      // One number in the badge: the share of the month's limit spent
      await waitFor(() => expect(usageTrigger).toHaveTextContent(/^54%$/));
      fireEvent.click(usageTrigger);

      const breakdown = within(await screen.findByRole('dialog'));
      expect(breakdown.getByText('54')).toBeInTheDocument();
      expect(breakdown.getByText(/136\.22 of .*250\.00 this month/)).toBeInTheDocument();
      // No window resets, and no weekly row
      expect(breakdown.queryByText('Week')).not.toBeInTheDocument();
      expect(breakdown.queryByText('common:usage.sessionNotStarted')).not.toBeInTheDocument();
    });

    it('shows a zero Fable limit rather than hiding the row', async () => {
      (window as any).electronAPI.requestUsageUpdate = vi.fn().mockResolvedValue({
        success: true,
        data: {
          profileId: 'account-anthropic',
          profileName: 'Anthropic',
          sessionPercent: 45,
          weeklyPercent: 55,
          fablePercent: 0,
          sessionResetTimestamp: '2026-03-04T12:00:00.000Z',
          weeklyResetTimestamp: '2026-03-11T12:00:00.000Z',
          fetchedAt: new Date(),
          needsReauthentication: false,
        },
      });

      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      fireEvent.click(usageTrigger);

      expect(await screen.findByText('Fable · Week')).toBeInTheDocument();
      expect(screen.getByText('0%')).toBeInTheDocument();
    });
  });

  describe('API profiles', () => {
    beforeEach(() => {
      // An API profile is in use (pay as you go, no usage monitoring)
      mockStore('api-1');
    });

    it('shows an API key badge instead of usage', async () => {
      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      await waitFor(() => expect(usageTrigger).toHaveTextContent('API key'));
      expect(usageTrigger).not.toHaveTextContent('45');
    });

    it('says there is no usage limit to show, with a way to manage accounts', async () => {
      render(<UsageIndicator />);
      const usageTrigger = await screen.findByRole('button', { name: 'common:usage.usageStatusAriaLabel' });
      fireEvent.click(usageTrigger);
      expect(await screen.findByText('common:usage.apiKeyUnknown')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'common:usage.manageAccounts' })).toBeInTheDocument();
    });
  });
});
