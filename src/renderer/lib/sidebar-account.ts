import type { ClaudeProfile } from '../../shared/types';
import type { APIProfile } from '../../shared/types/profile';

/** The account the sidebar's settings row names: what tasks and agents run on right now */
export interface SidebarAccount {
  name: string;
  /**
   * The plan: a known plan's i18n key under `navigation:account.plans` ("max", "pro", "team",
   * "enterprise", "api"), or the plan as Claude Code reports it
   */
  plan?: string;
  /** Whether `plan` is an i18n key (else it is shown as it is) */
  planIsKey: boolean;
}

const KNOWN_PLANS = new Set(['max', 'pro', 'team', 'enterprise']);

/**
 * The account to show, or null when none is added or detected yet (the row then says "Settings").
 * An active API profile wins, as it does when tasks and agents run.
 */
export function sidebarAccount(
  claudeProfiles: ClaudeProfile[],
  claudeActiveId: string | undefined,
  apiProfiles: APIProfile[],
  apiActiveId: string | null | undefined
): SidebarAccount | null {
  const api = apiActiveId ? apiProfiles.find((profile) => profile.id === apiActiveId) : undefined;
  if (api) return { name: api.name, plan: 'api', planIsKey: true };

  const claude = claudeProfiles.find((profile) => profile.id === claudeActiveId);
  if (!claude) return null;
  const raw = (claude.detected?.plan ?? claude.subscriptionType)?.trim();
  if (!raw) return { name: claude.name, planIsKey: false };
  const key = raw.toLowerCase();
  if (KNOWN_PLANS.has(key)) return { name: claude.name, plan: key, planIsKey: true };
  return { name: claude.name, plan: raw.charAt(0).toUpperCase() + raw.slice(1), planIsKey: false };
}
