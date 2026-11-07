/**
 * @vitest-environment jsdom
 */
/**
 * Settings > Accounts: each Claude account shows its own email and usage, never another
 * account's, and no numbers before its usage was fetched.
 */
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ClaudeProfile, ProfileUsageSummary } from '../../../../shared/types';
import { ClaudeAccountsSection } from '../ClaudeAccountsSection';
import { useClaudeAccounts } from '../hooks/useClaudeAccounts';
import { useClaudeProfileStore } from '../../../stores/claude-profile-store';
import { useSettingsStore } from '../../../stores/settings-store';

vi.mock('../hooks/useClaudeAccounts', () => ({ useClaudeAccounts: vi.fn() }));
vi.mock('../DetectedAccountDialog', () => ({ DetectedAccountDialog: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      key === 'claudeAccounts.usage' ? `Session ${params?.session}% · Weekly ${params?.weekly}%` : key,
  }),
}));

const subscription = { provider: 'subscription', values: [] } as unknown as ClaudeProfile['detected'];

function profile(id: string, name: string, email: string): ClaudeProfile {
  return { id, name, email, isDefault: false, isAuthenticated: true, createdAt: new Date(), detected: subscription } as ClaudeProfile;
}

function summary(profileId: string, values: Partial<ProfileUsageSummary>): ProfileUsageSummary {
  return {
    profileId,
    profileName: profileId,
    sessionPercent: 0,
    weeklyPercent: 0,
    isAuthenticated: true,
    isRateLimited: false,
    availabilityScore: 100,
    isActive: false,
    ...values,
  };
}

function renderWith(usage: ProfileUsageSummary[], activeProfileId = 'personal') {
  vi.mocked(useClaudeAccounts).mockReturnValue({
    profiles: [
      profile('personal', 'Personal', 'me@example.com'),
      profile('work', 'Work', 'me@work.example'),
      profile('new', 'New', 'new@example.com'),
    ],
    activeProfileId,
    isLoading: false,
    usage: new Map(usage.map((s) => [s.profileId, s] as const)),
    reload: vi.fn(async () => {}),
  });
  render(<ClaudeAccountsSection />);
}

describe('ClaudeAccountsSection', () => {
  it('shows each account with its own email and usage', () => {
    renderWith([
      summary('personal', { profileEmail: 'me@example.com', sessionPercent: 10, weeklyPercent: 20, isActive: true, lastFetchedAt: '2026-10-24T10:00:00Z' }),
      // A summary that carries the account in use's email must not rename this account
      summary('work', { profileEmail: 'me@example.com', sessionPercent: 70, weeklyPercent: 80, lastFetchedAt: '2026-10-24T10:00:00Z' }),
    ]);

    expect(screen.getByText('me@example.com · Session 10% · Weekly 20%')).toBeInTheDocument();
    expect(screen.getByText('me@work.example · Session 70% · Weekly 80%')).toBeInTheDocument();
  });

  it('shows no usage numbers for an account whose usage was never fetched', () => {
    renderWith([
      summary('personal', { sessionPercent: 10, weeklyPercent: 20, isActive: true, lastFetchedAt: '2026-10-24T10:00:00Z' }),
      // Placeholder from before the first fetch
      summary('new', { sessionPercent: 0, weeklyPercent: 0 }),
    ]);

    expect(screen.getByText('new@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/new@example\.com · Session/)).not.toBeInTheDocument();
    // No summary at all: just the email
    expect(screen.getByText('me@work.example')).toBeInTheDocument();
  });

  it('marks the window\'s account in use while no API profile is in use', () => {
    useClaudeProfileStore.setState({ profiles: [profile('personal', 'Personal', 'me@example.com')], activeProfileId: 'personal' });
    useSettingsStore.setState({ activeProfileId: null });
    renderWith([]);

    expect(screen.getAllByText('claudeAccounts.inUse')).toHaveLength(1);
  });

  it('marks no Claude account in use while an API profile is in use', () => {
    useClaudeProfileStore.setState({ profiles: [profile('personal', 'Personal', 'me@example.com')], activeProfileId: 'personal' });
    useSettingsStore.setState({ activeProfileId: 'api-profile' });
    renderWith([]);

    expect(screen.queryByText('claudeAccounts.inUse')).not.toBeInTheDocument();
    useSettingsStore.setState({ activeProfileId: null });
  });

  it('offers deleting only the accounts not in use, after a confirmation', async () => {
    useClaudeProfileStore.setState({ profiles: [profile('personal', 'Personal', 'me@example.com')], activeProfileId: 'personal' });
    useSettingsStore.setState({ activeProfileId: null });
    renderWith([]);

    // Rows: personal (in use), work, new
    const deleteButtons = screen.getAllByLabelText('claudeAccounts.deleteAriaLabel');
    expect(deleteButtons).toHaveLength(2);

    fireEvent.click(deleteButtons[0]);
    expect(await screen.findByText('claudeAccounts.dialog.deleteTitle')).toBeInTheDocument();
  });
});
