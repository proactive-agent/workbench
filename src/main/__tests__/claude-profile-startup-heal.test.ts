/**
 * Startup repair of the Claude account store, reproducing a real broken store:
 * - "primary" (signed in) flagged "Rate limited" by limit messages quoted in terminal output
 *   (reset "Dec 17 at 6am (Europe/Oslo)" followed by a quote and escape codes, two months away)
 * - "primary-1", a second "Primary" left by an "Add account" sign-in that never finished, active,
 *   with no credentials but with session files from runs that were switched to it
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userDataRef = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => userDataRef.dir },
}));

// Credentials live in <configDir>/.credentials.json in these tests (no keychain / secret-tool)
vi.mock('../claude-profile/credential-utils', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const read = (configDir?: string) => {
    const file = configDir ? path.join(configDir, '.credentials.json') : '';
    if (!file || !fs.existsSync(file)) return { token: null, email: null };
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { token: data?.claudeAiOauth?.accessToken ?? null, email: null };
  };
  return {
    getCredentialsFromKeychain: vi.fn(read),
    normalizeWindowsPath: (p: string) => p,
    updateProfileSubscriptionMetadata: vi.fn(() => ({})),
  };
});

// The machine's own Claude Code setups stay out of these tests
vi.mock('../claude-profile/claude-code-detection', () => ({
  detectClaudeCodeSetups: () => [],
  detectedAccountName: () => 'Claude Code',
}));

import { ClaudeProfileManager } from '../claude-profile-manager';
import type { ClaudeProfile } from '../../shared/types';

const ESC = '\u001b';

function signIn(configDir: string, email: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-test', refreshToken: 'sk-ant-ort01-test' },
  }));
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: email, accountUuid: 'acct-1', organizationUuid: 'org-1' },
  }));
}

describe('ClaudeProfileManager startup repair', () => {
  let root: string;
  let primaryDir: string;
  let duplicateDir: string;
  let storePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'profile-heal-'));
    userDataRef.dir = join(root, 'userData');
    mkdirSync(join(userDataRef.dir, 'config'), { recursive: true });
    storePath = join(userDataRef.dir, 'config', 'claude-profiles.json');

    primaryDir = join(root, 'profiles', 'primary');
    duplicateDir = join(root, 'profiles', 'primary-1');
    signIn(primaryDir, 'me@example.com');

    // Never signed in, but Claude Code ran with it: .claude.json without an account,
    // session transcripts under projects/, a settings.json
    mkdirSync(join(duplicateDir, 'projects', '-home-me-project'), { recursive: true });
    writeFileSync(join(duplicateDir, '.claude.json'), JSON.stringify({ firstStartTime: '2026-10-10T16:07:04.328Z' }));
    writeFileSync(join(duplicateDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));

    const hit = new Date(Date.now() - 60 * 60 * 1000);
    const twoMonthsLater = new Date(hit.getTime() + 68 * 24 * 60 * 60 * 1000);
    writeFileSync(storePath, JSON.stringify({
      version: 3,
      profiles: [
        {
          id: 'primary',
          name: 'Primary',
          configDir: primaryDir,
          isDefault: true,
          createdAt: '2026-10-06T01:30:27.821Z',
          email: 'me@example.com',
          usage: { sessionUsagePercent: 22, sessionResetTime: '', weeklyUsagePercent: 49, weeklyResetTime: '', lastUpdated: new Date().toISOString() },
          rateLimitEvents: [
            { type: 'weekly', hitAt: hit.toISOString(), resetAt: twoMonthsLater.toISOString(), resetTimeString: `Dec 17 at 6am (Europe/Oslo)"${ESC}[38;2;248;248;242m` },
            { type: 'weekly', hitAt: hit.toISOString(), resetAt: twoMonthsLater.toISOString(), resetTimeString: `Dec 17 at 6am (Europe/Oslo)'${ESC}[38;2;248;248;242m))` },
          ],
        },
        {
          id: 'primary-1',
          name: 'Primary',
          isDefault: false,
          isAuthenticated: false,
          configDir: duplicateDir,
          createdAt: '2026-10-07T15:51:30.289Z',
        },
      ],
      activeProfileId: 'primary-1',
      // Saved before automatic account switching was removed: still loads, and is dropped
      autoSwitch: { enabled: true, proactiveSwapEnabled: true, sessionThreshold: 95, weeklyThreshold: 99 },
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not treat session files or settings.json as a sign-in', async () => {
    const manager = new ClaudeProfileManager();
    const duplicate = { id: 'x', name: 'X', configDir: duplicateDir, isDefault: false, createdAt: new Date() } as ClaudeProfile;
    expect(manager.isProfileAuthenticated(duplicate)).toBe(false);
    expect(manager.isProfileAuthenticated({ ...duplicate, configDir: primaryDir })).toBe(true);
  });

  it('removes the never-signed-in duplicate, switches back to the signed-in account and drops the bogus rate limits', async () => {
    const manager = new ClaudeProfileManager();
    await manager.initialize();

    const settings = manager.getSettings();
    expect(settings.profiles.map(p => p.id)).toEqual(['primary']);
    expect(settings.activeProfileId).toBe('primary');
    expect(manager.isProfileRateLimited('primary')).toEqual({ limited: false });

    // Persisted, and the duplicate's config dir is left alone on disk
    const stored = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(stored.profiles.map((p: ClaudeProfile) => p.id)).toEqual(['primary']);
    expect(stored.activeProfileId).toBe('primary');
    expect(stored.profiles[0].rateLimitEvents).toEqual([]);
    expect(stored.autoSwitch).toBeUndefined();
    expect(existsSync(duplicateDir)).toBe(true);
  });

  it('keeps an unfinished sign-in whose name is not taken by another account', async () => {
    const store = JSON.parse(readFileSync(storePath, 'utf-8'));
    store.profiles[1].name = 'Work';
    writeFileSync(storePath, JSON.stringify(store));

    const manager = new ClaudeProfileManager();
    await manager.initialize();

    expect(manager.getSettings().profiles.map(p => p.id)).toEqual(['primary', 'primary-1']);
    // Still switched away from it: it can't run anything
    expect(manager.getSettings().activeProfileId).toBe('primary');
    expect(manager.findAbandonedProfileByName('work')?.id).toBe('primary-1');
  });
});

describe('ClaudeProfileManager rate limit recording', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'profile-limit-'));
    userDataRef.dir = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function managerWith(profile: ClaudeProfile): ClaudeProfileManager {
    const manager = new ClaudeProfileManager();
    (manager as unknown as { data: { profiles: ClaudeProfile[] } }).data.profiles = [profile];
    return manager;
  }

  it('ignores a reset string quoted in terminal output', () => {
    const manager = managerWith({ id: 'p', name: 'P', configDir: root, isDefault: true, createdAt: new Date() });

    expect(manager.recordRateLimitEvent('p', `Dec 17 at 6am (Europe/Oslo)"${ESC}[38;2;248;248;242m`)).toBeNull();
    expect(manager.isProfileRateLimited('p').limited).toBe(false);
  });

  it('ignores a reset that is further away than any Claude limit', () => {
    const manager = managerWith({ id: 'p', name: 'P', configDir: root, isDefault: true, createdAt: new Date() });
    const farAway = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    expect(manager.recordRateLimitEvent('p', `${months[farAway.getMonth()]} ${farAway.getDate()} at 6am`)).toBeNull();
    expect(manager.isProfileRateLimited('p').limited).toBe(false);
  });

  it('records a real session limit', () => {
    const manager = managerWith({ id: 'p', name: 'P', configDir: root, isDefault: true, createdAt: new Date() });

    const event = manager.recordRateLimitEvent('p', '11:59pm');
    expect(event?.type).toBe('session');
    expect(manager.isProfileRateLimited('p').limited).toBe(true);
  });

  it('records an exact reset time as a session limit when it is hours away', () => {
    const manager = managerWith({ id: 'p', name: 'P', configDir: root, isDefault: true, createdAt: new Date() });
    const resetAt = new Date(Date.now() + 60 * 60 * 1000);

    const event = manager.recordRateLimitEvent('p', '', { resetAt });
    expect(event).toMatchObject({ type: 'session', resetAt });
  });
});

describe('ClaudeProfileManager same-account sign-in', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'profile-same-account-'));
    userDataRef.dir = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps one entry when a new account signs in to an account already in the list', () => {
    const oldDir = join(root, 'primary');
    const newDir = join(root, 'personal');
    signIn(oldDir, 'me@example.com');
    signIn(newDir, 'me@example.com');
    const manager = new ClaudeProfileManager();
    const internals = manager as unknown as { data: { profiles: ClaudeProfile[]; activeProfileId: string } };
    internals.data.profiles = [
      { id: 'primary', name: 'Primary', configDir: oldDir, isDefault: true, createdAt: new Date(0), email: 'me@example.com' },
      { id: 'personal', name: 'Personal', configDir: newDir, isDefault: false, createdAt: new Date(), email: 'me@example.com' },
    ];
    internals.data.activeProfileId = 'personal';

    const kept = manager.mergeSameAccountProfile('personal');

    expect(kept?.id).toBe('primary');
    expect(internals.data.profiles.map(p => p.id)).toEqual(['primary']);
    expect(internals.data.activeProfileId).toBe('primary');
  });

  it('keeps accounts of different organizations with the same email', () => {
    const personalDir = join(root, 'personal');
    const teamDir = join(root, 'team');
    signIn(personalDir, 'me@example.com');
    signIn(teamDir, 'me@example.com');
    writeFileSync(join(teamDir, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'me@example.com', accountUuid: 'acct-1', organizationUuid: 'org-team' },
    }));
    const manager = new ClaudeProfileManager();
    const internals = manager as unknown as { data: { profiles: ClaudeProfile[] } };
    internals.data.profiles = [
      { id: 'personal', name: 'Personal', configDir: personalDir, isDefault: true, createdAt: new Date(0) },
      { id: 'team', name: 'Team', configDir: teamDir, isDefault: false, createdAt: new Date() },
    ];

    expect(manager.mergeSameAccountProfile('team')).toBeNull();
    expect(internals.data.profiles.map(p => p.id)).toEqual(['personal', 'team']);
  });
});
