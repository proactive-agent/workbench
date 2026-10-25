import { describe, expect, it } from 'vitest';
import { sidebarAccount } from '../sidebar-account';
import type { ClaudeProfile } from '../../../shared/types';
import type { APIProfile } from '../../../shared/types/profile';

const claude = (fields: Partial<ClaudeProfile>): ClaudeProfile =>
  ({ id: 'c1', name: 'Personal', isDefault: false, createdAt: new Date(), ...fields }) as ClaudeProfile;
const api = (fields: Partial<APIProfile>): APIProfile =>
  ({ id: 'a1', name: 'Gateway', baseUrl: 'https://example.com', apiKey: 'k', createdAt: 0, updatedAt: 0, ...fields }) as APIProfile;

describe('sidebarAccount', () => {
  it('is null without an account, so the row says Settings', () => {
    expect(sidebarAccount([], 'default', [], null)).toBeNull();
    expect(sidebarAccount([claude({ id: 'other' })], 'c1', [], null)).toBeNull();
  });

  it('names the active Claude account with its detected plan', () => {
    const profiles = [
      claude({ id: 'c1', name: 'Personal', detected: { provider: 'subscription', isDefaultDir: true, plan: 'max', values: [] } }),
      claude({ id: 'c2', name: 'Vertex LLC', detected: { provider: 'subscription', isDefaultDir: false, plan: 'team', values: [] } }),
    ];
    expect(sidebarAccount(profiles, 'c2', [], null)).toEqual({ name: 'Vertex LLC', plan: 'team', planIsKey: true });
  });

  it('falls back to the subscription type, and shows an unknown plan as it is', () => {
    expect(sidebarAccount([claude({ subscriptionType: 'Pro' })], 'c1', [], null)).toEqual({ name: 'Personal', plan: 'pro', planIsKey: true });
    expect(sidebarAccount([claude({ subscriptionType: 'education' })], 'c1', [], null)).toEqual({ name: 'Personal', plan: 'Education', planIsKey: false });
    expect(sidebarAccount([claude({})], 'c1', [], null)).toEqual({ name: 'Personal', planIsKey: false });
  });

  it('names an active API profile first, as runs use it', () => {
    expect(sidebarAccount([claude({})], 'c1', [api({})], 'a1')).toEqual({ name: 'Gateway', plan: 'api', planIsKey: true });
    // An active id that no longer exists falls back to the Claude account
    expect(sidebarAccount([claude({})], 'c1', [api({})], 'gone')).toMatchObject({ name: 'Personal' });
  });
});
