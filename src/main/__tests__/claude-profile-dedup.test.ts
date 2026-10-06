import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const userDataRef = vi.hoisted(() => ({ dir: '' }));
const settingsRef = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('electron', () => ({
  app: { getPath: () => userDataRef.dir },
}));

vi.mock('../settings-utils', () => ({
  readSettingsFile: () => settingsRef.value,
  writeSettingsFile: (settings: Record<string, unknown>) => {
    settingsRef.value = settings;
  },
}));

import { ClaudeProfileManager } from '../claude-profile-manager';
import type { ClaudeProfile } from '../../shared/types';

function profile(id: string, configDir: string, overrides: Partial<ClaudeProfile> = {}): ClaudeProfile {
  return { id, name: id, configDir, isDefault: false, createdAt: new Date(0), ...overrides };
}

type ManagerInternals = {
  data: { profiles: ClaudeProfile[]; activeProfileId: string; accountPriorityOrder?: string[] };
  deduplicateProfiles: () => void;
};

describe('ClaudeProfileManager profile deduplication', () => {
  let manager: ClaudeProfileManager;
  let internals: ManagerInternals;

  beforeEach(() => {
    userDataRef.dir = mkdtempSync(join(tmpdir(), 'profile-dedup-'));
    settingsRef.value = {};
    manager = new ClaudeProfileManager();
    internals = manager as unknown as ManagerInternals;
    internals.data.profiles = [];
  });

  afterEach(() => {
    rmSync(userDataRef.dir, { recursive: true, force: true });
  });

  it('updates the existing entry when a new id arrives for the same configDir', () => {
    manager.saveProfile(profile('first', '/profiles/work', { isDefault: true }));
    const saved = manager.saveProfile(profile('second', '/profiles/work', { name: 'Work (re-added)' }));

    expect(internals.data.profiles).toHaveLength(1);
    expect(saved.id).toBe('first');
    expect(saved.isDefault).toBe(true);
    expect(internals.data.profiles[0].name).toBe('Work (re-added)');
  });

  it('keeps existing account data when a skeleton is saved for the same configDir', () => {
    manager.saveProfile(profile('work', '/profiles/work', { email: 'me@example.com', oauthToken: 'tok' }));
    manager.saveProfile(profile('work-1', '/profiles/work/'));

    expect(internals.data.profiles).toHaveLength(1);
    expect(internals.data.profiles[0]).toMatchObject({ id: 'work', email: 'me@example.com', oauthToken: 'tok' });
  });

  it('still adds profiles with a different configDir', () => {
    manager.saveProfile(profile('a', '/profiles/a'));
    manager.saveProfile(profile('b', '/profiles/b'));

    expect(internals.data.profiles.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('removes duplicates on startup, remapping the active profile and priority order', () => {
    internals.data.profiles = [
      profile('keep', '/profiles/work'),
      profile('other', '/profiles/personal'),
      profile('dup', '/profiles/work'),
    ];
    internals.data.activeProfileId = 'dup';
    internals.data.accountPriorityOrder = ['oauth-dup', 'oauth-keep', 'oauth-other', 'api-x'];

    internals.deduplicateProfiles();

    expect(internals.data.profiles.map(p => p.id)).toEqual(['keep', 'other']);
    expect(internals.data.activeProfileId).toBe('keep');
    expect(internals.data.accountPriorityOrder).toEqual(['oauth-keep', 'oauth-other', 'api-x']);
  });

  it('merges data that only a duplicate has into the kept profile', () => {
    internals.data.profiles = [
      profile('keep', '/profiles/work'),
      profile('dup', '/profiles/work', { isDefault: true, oauthToken: 'tok', email: 'me@example.com' }),
    ];

    internals.deduplicateProfiles();

    expect(internals.data.profiles).toHaveLength(1);
    expect(internals.data.profiles[0]).toMatchObject({ id: 'keep', isDefault: true, oauthToken: 'tok', email: 'me@example.com' });
  });

  it('treats ~ and absolute forms of the same configDir as duplicates', () => {
    internals.data.profiles = [
      profile('keep', join(homedir(), '.claude-profiles', 'work')),
      profile('dup', '~/.claude-profiles/work/'),
    ];

    internals.deduplicateProfiles();

    expect(internals.data.profiles.map(p => p.id)).toEqual(['keep']);
  });

  it('remaps provider accounts that pointed at a removed duplicate', () => {
    settingsRef.value = {
      providerAccounts: [{ id: 'acc-1', claudeProfileId: 'dup' }, { id: 'acc-2', claudeProfileId: 'other' }],
    };
    internals.data.profiles = [profile('keep', '/profiles/work'), profile('dup', '/profiles/work')];

    internals.deduplicateProfiles();

    expect(settingsRef.value.providerAccounts).toEqual([
      { id: 'acc-1', claudeProfileId: 'keep' },
      { id: 'acc-2', claudeProfileId: 'other' },
    ]);
  });
});
