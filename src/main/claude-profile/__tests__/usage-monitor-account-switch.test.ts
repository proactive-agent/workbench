/**
 * Switching the Claude account in use: the usage badge follows the new account right away, and
 * every account in the list keeps its own email and usage (never the account in use's).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClaudeUsageSnapshot, AllProfilesUsage } from '../../../shared/types/agent';

interface FakeProfile {
  id: string;
  name: string;
  email?: string;
  configDir: string;
  isAuthenticated: boolean;
  usage?: { sessionUsagePercent: number; weeklyUsagePercent: number; lastUpdated: Date };
}

const state = vi.hoisted(() => ({
  profiles: [] as FakeProfile[],
  activeProfileId: '',
  listeners: new Set<(id: string, previous: string) => void>(),
}));

vi.mock('../../claude-profile-manager', () => {
  const manager = {
    getSettings: () => ({ profiles: state.profiles, activeProfileId: state.activeProfileId }),
    getActiveProfile: () => state.profiles.find((p) => p.id === state.activeProfileId),
    getProfile: (id: string) => state.profiles.find((p) => p.id === id),
    setActiveProfile: (id: string) => {
      const previous = state.activeProfileId;
      state.activeProfileId = id;
      if (previous !== id) state.listeners.forEach((listener) => listener(id, previous));
      return true;
    },
    onActiveProfileChanged: (listener: (id: string, previous: string) => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    updateProfileUsageFromAPI: vi.fn(),
    batchUpdateProfileUsageFromAPI: vi.fn(),
  };
  return { getClaudeProfileManager: () => manager };
});

// Each config dir has its own sign-in
const tokenFor = (configDir: string | undefined) => `token-${configDir?.split('/').pop()}`;
vi.mock('../credential-utils', () => ({
  getCredentialsFromKeychain: (configDir?: string) => ({ token: tokenFor(configDir), email: null }),
  clearKeychainCache: vi.fn(),
}));
vi.mock('../token-refresh', () => ({
  ensureValidToken: async (configDir?: string) => ({ token: tokenFor(configDir), wasRefreshed: false }),
  reactiveTokenRefresh: vi.fn(),
}));
vi.mock('../../services/profile/profile-manager', () => ({
  loadProfilesFile: async () => ({ profiles: [], activeProfileId: null, version: 1 }),
}));
vi.mock('../rate-limit-manager', () => ({ isProfileRateLimited: () => ({ limited: false }) }));
vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: vi.fn(async () => undefined),
  readSettingsFile: vi.fn(() => undefined),
}));

import { UsageMonitor } from '../usage-monitor';

// The usage endpoint answers with the numbers of whichever account's token it is called with
const USAGE_BY_TOKEN: Record<string, { session: number; weekly: number }> = {
  'token-.claude': { session: 10, weekly: 20 },
  'token-.claude-2': { session: 70, weekly: 80 },
};

function newMonitor(): UsageMonitor {
  return new (UsageMonitor as unknown as new () => UsageMonitor)();
}

function checkNowAndWait(monitor: UsageMonitor): Promise<void> {
  return (monitor as unknown as { checkUsage: () => Promise<void> }).checkUsage();
}

describe('UsageMonitor account switch', () => {
  beforeEach(() => {
    state.profiles = [
      { id: 'claude-code', name: 'Personal', email: 'me@example.com', configDir: '/home/me/.claude', isAuthenticated: true },
      { id: 'claude-code-2', name: 'Work', email: 'me@work.example', configDir: '/home/me/.claude-2', isAuthenticated: true },
    ];
    state.activeProfileId = 'claude-code';
    state.listeners.clear();
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const token = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
      const usage = USAGE_BY_TOKEN[token];
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          five_hour: { utilization: usage.session, resets_at: '2026-10-24T20:00:00Z' },
          seven_day: { utilization: usage.weekly, resets_at: '2026-10-30T20:00:00Z' },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives every account its own usage and email, not the account in use\'s', async () => {
    const monitor = newMonitor();
    await checkNowAndWait(monitor);
    expect(monitor.getCurrentUsage()?.profileId).toBe('claude-code');

    // The other account's cached usage expired, and the account in use changes to it before its
    // own usage was fetched
    monitor.clearProfileUsageCache('claude-code-2');
    state.activeProfileId = 'claude-code-2';
    const all = await monitor.getAllProfilesUsage();

    const personal = all?.allProfiles.find((p) => p.profileId === 'claude-code');
    const work = all?.allProfiles.find((p) => p.profileId === 'claude-code-2');
    expect(personal).toMatchObject({ profileEmail: 'me@example.com', sessionPercent: 10, weeklyPercent: 20, isActive: false });
    expect(work).toMatchObject({ profileEmail: 'me@work.example', sessionPercent: 70, weeklyPercent: 80, isActive: true });
    expect(all?.activeProfile.profileId).not.toBe('claude-code');
  });

  it('keeps each account\'s numbers after the new account\'s usage is fetched', async () => {
    const monitor = newMonitor();
    await checkNowAndWait(monitor);
    state.activeProfileId = 'claude-code-2';
    await checkNowAndWait(monitor);

    const all = await monitor.getAllProfilesUsage();
    expect(all?.allProfiles.find((p) => p.profileId === 'claude-code')).toMatchObject({ sessionPercent: 10, weeklyPercent: 20 });
    expect(all?.allProfiles.find((p) => p.profileId === 'claude-code-2')).toMatchObject({ sessionPercent: 70, weeklyPercent: 80 });
  });

  it('shows the new account\'s stored usage as soon as the account is switched, then refreshes it', async () => {
    const monitor = newMonitor();
    const updates: Array<ClaudeUsageSnapshot | null> = [];
    const lists: AllProfilesUsage[] = [];
    monitor.on('usage-updated', (usage) => updates.push(usage));
    monitor.on('all-profiles-usage-updated', (all) => lists.push(all));
    monitor.start();
    try {
      // The first check fetched the account in use and (as inactive) the other one
      await vi.waitFor(() => expect(lists.length).toBe(1));
      expect(updates.at(-1)?.profileId).toBe('claude-code');
      updates.length = 0;
      lists.length = 0;

      // Like Settings > Accounts or an agent window's account menu
      const { getClaudeProfileManager } = await import('../../claude-profile-manager');
      getClaudeProfileManager().setActiveProfile('claude-code-2');

      // Synchronously: the badge and the list follow the new account from what is stored
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ profileId: 'claude-code-2', sessionPercent: 70, weeklyPercent: 80 });
      expect(lists[0].allProfiles.find((p) => p.isActive)?.profileId).toBe('claude-code-2');
      expect(monitor.getCurrentUsage()?.profileId).toBe('claude-code-2');

      // Then a background fetch of the new account
      await vi.waitFor(() => expect(updates).toHaveLength(2));
      expect(updates[1]).toMatchObject({ profileId: 'claude-code-2', sessionPercent: 70, weeklyPercent: 80 });
    } finally {
      monitor.stop();
    }
  });

  it('clears the badge when switching to an account whose usage was never fetched', () => {
    const monitor = newMonitor();
    const updates: Array<ClaudeUsageSnapshot | null> = [];
    monitor.on('usage-updated', (usage) => updates.push(usage));
    monitor['currentUsage'] = { profileId: 'claude-code', profileName: 'Personal', sessionPercent: 10, weeklyPercent: 20, fetchedAt: new Date() };
    monitor['currentUsageProfileId'] = 'claude-code';
    // Don't run the background fetch here
    monitor['isChecking'] = true;

    state.activeProfileId = 'claude-code-2';
    monitor.handleActiveProfileChanged('claude-code-2');

    expect(updates).toEqual([null]);
    expect(monitor.getCurrentUsage()).toBeNull();
  });

  it('does not store the previous account\'s usage when the switch happens during a fetch', async () => {
    const monitor = newMonitor();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
      await gate;
      return realFetch(...args);
    }) as unknown as typeof fetch;

    const check = checkNowAndWait(monitor);
    state.activeProfileId = 'claude-code-2';
    monitor.handleActiveProfileChanged('claude-code-2');
    global.fetch = realFetch;
    release();
    await check;

    // The check queued behind it fetches the new account
    await vi.waitFor(() => expect(monitor.getCurrentUsage()?.profileId).toBe('claude-code-2'));
    expect(monitor.getCurrentUsage()).toMatchObject({ sessionPercent: 70, weeklyPercent: 80 });
  });
});
