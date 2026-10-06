import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userDataRef = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => userDataRef.dir },
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
});
