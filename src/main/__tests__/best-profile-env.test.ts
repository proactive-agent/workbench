/**
 * Runs stay on the account in use, also when it is rate limited; only an account without
 * credentials (which can't run at all) is replaced by a signed-in one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaudeProfile } from '../../shared/types';

type Profile = Pick<ClaudeProfile, 'id' | 'name' | 'configDir'> & { signedIn: boolean; limited?: boolean };

const state = vi.hoisted(() => ({
  profiles: [] as Array<{ id: string; name: string; configDir?: string; signedIn: boolean; limited?: boolean }>,
  activeId: '',
}));

const manager = vi.hoisted(() => ({
  getActiveProfile: vi.fn(() => state.profiles.find(p => p.id === state.activeId)),
  getProfile: vi.fn((id: string) => state.profiles.find(p => p.id === id)),
  getSettings: vi.fn(() => ({ profiles: state.profiles, activeProfileId: state.activeId })),
  hasValidAuth: vi.fn((id: string) => !!state.profiles.find(p => p.id === id)?.signedIn),
  isProfileRateLimited: vi.fn((id: string) => ({ limited: !!state.profiles.find(p => p.id === id)?.limited })),
  setActiveProfile: vi.fn((id: string) => { state.activeId = id; return true; }),
  getProfileEnv: vi.fn((id: string) => ({ CLAUDE_CONFIG_DIR: `/profiles/${id}` })),
  getActiveProfileEnv: vi.fn(() => ({ CLAUDE_CONFIG_DIR: `/profiles/${state.activeId}` })),
}));

vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: () => manager }));
vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { getRunnableProfileEnv, getUsableProfileEnv } from '../rate-limit-detector';

function setProfiles(profiles: Profile[], activeId: string): void {
  state.profiles = profiles;
  state.activeId = activeId;
}

describe('getRunnableProfileEnv', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stays on a rate-limited account even when another signed-in account is free', () => {
    setProfiles([
      { id: 'primary', name: 'Primary', configDir: '/profiles/primary', signedIn: true, limited: true },
      { id: 'second', name: 'Second', configDir: '/profiles/second', signedIn: true },
    ], 'primary');

    const result = getRunnableProfileEnv();

    expect(result.profileId).toBe('primary');
    expect(result.wasSignedOut).toBe(false);
    expect(result.env.CLAUDE_CONFIG_DIR).toBe('/profiles/primary');
    expect(manager.setActiveProfile).not.toHaveBeenCalled();
  });

  it('moves away from an active account without credentials to a signed-in one', () => {
    setProfiles([
      { id: 'primary', name: 'Primary', configDir: '/profiles/primary', signedIn: true },
      { id: 'primary-1', name: 'Primary', configDir: '/profiles/primary-1', signedIn: false },
    ], 'primary-1');

    const result = getRunnableProfileEnv();

    expect(result).toMatchObject({ profileId: 'primary', wasSignedOut: true });
    expect(result.env.CLAUDE_CONFIG_DIR).toBe('/profiles/primary');
    expect(manager.setActiveProfile).toHaveBeenCalledWith('primary');
  });

  it('stays on an account without credentials when no other account is signed in', () => {
    setProfiles([
      { id: 'primary', name: 'Primary', configDir: '/profiles/primary', signedIn: false },
    ], 'primary');

    const result = getRunnableProfileEnv();

    expect(result.profileId).toBe('primary');
    expect(manager.setActiveProfile).not.toHaveBeenCalled();
  });
});

describe('getUsableProfileEnv', () => {
  it('returns null for a removed profile or one without credentials', () => {
    setProfiles([
      { id: 'primary', name: 'Primary', configDir: '/profiles/primary', signedIn: true },
      { id: 'primary-1', name: 'Primary', configDir: '/profiles/primary-1', signedIn: false },
    ], 'primary');

    expect(getUsableProfileEnv('primary')).toEqual({ CLAUDE_CONFIG_DIR: '/profiles/primary' });
    expect(getUsableProfileEnv('primary-1')).toBeNull();
    expect(getUsableProfileEnv('gone')).toBeNull();
  });
});
