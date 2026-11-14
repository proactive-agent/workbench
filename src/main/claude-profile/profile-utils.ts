/**
 * Profile Utilities Module
 * Helper functions for profile operations
 */

import { expandClaudeHome, joinClaudeHome } from '../platform/claude-home';
import { join } from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import type { ClaudeProfile } from '../../shared/types';
import { getCredentialsFromKeychain } from './credential-utils';
import { getClaudeGlobalConfigPath } from './config-dir-paths';

// Track which configDirs have already been warned about missing platform credentials.
// This prevents log spam when isProfileAuthenticated() is called repeatedly per profile.
const warnedStaleProfiles = new Set<string>();

/**
 * Default profiles directory for additional accounts (in the Linux home when Claude Code runs in WSL)
 */
export function getClaudeProfilesDir(): string {
  return joinClaudeHome('.claude-profiles');
}

/**
 * Generate a unique ID for a new profile
 */
export function generateProfileId(name: string, existingProfiles: ClaudeProfile[]): string {
  const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let id = baseId;
  let counter = 1;

  while (existingProfiles.some(p => p.id === id)) {
    id = `${baseId}-${counter}`;
    counter++;
  }

  return id;
}

/**
 * Create a new profile directory and initialize it
 */
export async function createProfileDirectory(profileName: string): Promise<string> {
  // Create profiles directory - mkdirSync with recursive:true is idempotent
  // and won't throw if the directory already exists, so no existsSync check needed
  const profilesDir = getClaudeProfilesDir();
  mkdirSync(profilesDir, { recursive: true });

  // Create directory for this profile
  const sanitizedName = profileName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const profileDir = join(profilesDir, sanitizedName);

  // mkdirSync with recursive:true is idempotent and won't throw if directory exists
  // No existsSync check needed - avoids TOCTOU race condition
  mkdirSync(profileDir, { recursive: true });

  return profileDir;
}

/**
 * Check if a profile has valid authentication
 * (checks for OAuth token or config directory credential files)
 */
export function isProfileAuthenticated(profile: ClaudeProfile): boolean {
  // A detected Claude Code setup that isn't a subscription sign-in (a cloud provider, an API key
  // or a gateway) is authenticated by Claude Code itself
  if (!usesClaudeSubscription(profile)) {
    return true;
  }

  // Check for direct OAuth token first (OAuth-only profiles without configDir)
  // (profiles that only have oauthToken set)
  if (hasValidToken(profile)) {
    return true;
  }

  // Check for configDir-based credentials (legacy or CLI-authenticated profiles)
  const configDir = profile.configDir;
  if (!configDir || !existsSync(configDir)) {
    return false;
  }

  // Check for .claude.json with OAuth account info (modern Claude Code CLI)
  // This is how Claude Code CLI stores OAuth authentication since v1.0
  const claudeJsonPath = getClaudeGlobalConfigPath(configDir);
  if (existsSync(claudeJsonPath)) {
    try {
      const content = readFileSync(claudeJsonPath, 'utf-8');
      const data = JSON.parse(content);
      // Check for oauthAccount which indicates successful OAuth authentication
      if (data && typeof data === 'object' && (data.oauthAccount?.accountUuid || data.oauthAccount?.emailAddress)) {
        // The actual OAuth tokens are stored in platform-specific credential storage:
        // - macOS: Keychain
        // - Windows: Credential Manager
        // - Linux: Secret Service or .credentials.json file
        // We need to verify that the credential store actually has the tokens
        // Expand ~ in configDir before checking credentials
        const expandedConfigDir = expandClaudeHome(configDir);
        const platformCreds = getCredentialsFromKeychain(expandedConfigDir);
        if (!platformCreds.token) {
          // .claude.json exists but credential store is missing tokens - NOT authenticated
          // Only warn once per configDir per session to avoid log spam from repeated calls
          if (!warnedStaleProfiles.has(configDir)) {
            warnedStaleProfiles.add(configDir);
            console.warn(`[profile-utils] Profile has .claude.json but no platform credentials for: ${configDir} — needs re-authentication`);
          }
          return false;
        }
        return true;
      }
    } catch (error) {
      // Log parse errors for debugging, but fall through to legacy checks
      console.warn(`[profile-utils] Failed to read or parse ${claudeJsonPath}:`, error);
    }
  }

  // Check for .credentials.json with OAuth tokens (Linux CLI storage)
  // On Linux, the Claude CLI stores OAuth tokens in this file
  const credentialsJsonPath = join(configDir, '.credentials.json');
  if (existsSync(credentialsJsonPath)) {
    try {
      const content = readFileSync(credentialsJsonPath, 'utf-8');
      const data = JSON.parse(content);
      // Validate OAuth data structure
      // Check for claudeAiOauth (primary Linux structure)
      if (data && typeof data === 'object' && data.claudeAiOauth) {
        // Validate that claudeAiOauth contains actual auth data
        const hasValidAuth = data.claudeAiOauth.accessToken ||
                             data.claudeAiOauth.refreshToken ||
                             data.claudeAiOauth.email ||
                             data.claudeAiOauth.emailAddress;
        if (hasValidAuth) {
          return true;
        }
      }
      // Check for oauthAccount (alternative structure)
      if (data && typeof data === 'object' && data.oauthAccount?.emailAddress) {
        return true;
      }
      // Check for generic token fields (legacy formats)
      if (data && typeof data === 'object' && (data.accessToken || data.refreshToken || data.token)) {
        return true;
      }
    } catch (error) {
      // Log parse errors for debugging, but fall through to legacy checks
      console.warn(`[profile-utils] Failed to read or parse ${credentialsJsonPath}:`, error);
    }
  }

  // Legacy: Claude stores auth in .claude/credentials or similar files.
  // (settings.json and session transcripts under projects/ are NOT signs of a sign-in: Claude
  // Code writes them in any config dir it runs with, signed in or not. Counting them made a
  // never-signed-in account look authenticated, so tasks were switched to it.)
  const possibleAuthFiles = [
    join(configDir, 'credentials'),
    join(configDir, 'credentials.json'),
    join(configDir, '.credentials'),
  ];

  for (const authFile of possibleAuthFiles) {
    if (existsSync(authFile)) {
      try {
        const content = readFileSync(authFile, 'utf-8');
        // Check if file has actual content (not just empty or placeholder)
        if (content.length > 10) {
          return true;
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  // Last resort: a token in the platform credential store for this config dir
  try {
    const expandedConfigDir = expandClaudeHome(configDir);
    if (getCredentialsFromKeychain(expandedConfigDir).token) {
      return true;
    }
  } catch {
    // Credential store unavailable
  }

  return false;
}

/**
 * Check if a profile has a valid OAuth token stored in the profile.
 *
 * DEPRECATED: This function checks for CACHED OAuth tokens which we no longer store.
 * OAuth tokens expire in 8-12 hours, not 1 year. We now use CLAUDE_CONFIG_DIR
 * to let Claude CLI read fresh tokens from Keychain on each invocation.
 *
 * This function is kept for backwards compatibility with existing profiles that
 * have oauthToken stored. For these profiles, we return true (assuming token might
 * still be valid) and let the actual API call determine if re-auth is needed.
 *
 * New profiles will NOT have oauthToken stored (per the auth flow changes).
 * Use isProfileAuthenticated() to check for configDir-based credentials instead.
 *
 * See: docs/LONG_LIVED_AUTH_PLAN.md for full context.
 */
export function hasValidToken(profile: ClaudeProfile): boolean {
  if (!profile?.oauthToken) {
    return false;
  }

  // For legacy profiles with stored oauthToken, return true.
  // The actual token validity is determined by the Keychain (via CLAUDE_CONFIG_DIR).
  // We keep this for backwards compat to avoid breaking existing profiles during migration.
  console.warn('[hasValidToken] DEPRECATED: Profile has cached oauthToken. Using CLAUDE_CONFIG_DIR for fresh tokens.');
  return true;
}

/**
 * Expand ~ in path to home directory
 */
export function expandHomePath(path: string): string {
  return expandClaudeHome(path);
}

/**
 * Get the email address from a profile's Claude config file (.claude.json).
 *
 * This reads the email directly from Claude's config file, which is the authoritative
 * source for the user's email. This is more reliable than parsing terminal output
 * which may contain ANSI escape codes that corrupt the email.
 *
 * @param configDir - The profile's config directory (e.g., ~/.claude or ~/.claude-profiles/work)
 * @returns The email address if found, null otherwise
 */
/**
 * Claude plan of the account signed in to a profile's config dir, e.g. "max" or "pro".
 *
 * Read from `.claude.json` → `oauthAccount.organizationType` ("claude_max", "claude_pro", …), which
 * Claude Code refreshes from Anthropic's OAuth profile endpoint. The `subscriptionType` stored with
 * the credentials is only captured at sign-in and goes stale after a plan change, so it isn't used.
 * Returns null when unknown (not signed in, API-only organization, file missing).
 */
export function getPlanFromConfigDir(configDir?: string): string | null {
  if (!configDir) return null;
  const claudeJsonPath = getClaudeGlobalConfigPath(configDir);
  if (!existsSync(claudeJsonPath)) return null;
  try {
    const organizationType = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))?.oauthAccount?.organizationType;
    if (typeof organizationType !== 'string') return null;
    const match = /^claude_([a-z]+)$/i.exec(organizationType.trim());
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export function getEmailFromConfigDir(configDir?: string): string | null {
  if (!configDir) {
    return null;
  }

  // Expand ~ to home directory
  const expandedConfigDir = expandHomePath(configDir);

  // Check .claude.json (primary config file)
  const claudeJsonPath = getClaudeGlobalConfigPath(expandedConfigDir);
  if (existsSync(claudeJsonPath)) {
    try {
      const content = readFileSync(claudeJsonPath, 'utf-8');
      const data = JSON.parse(content);

      // Check for oauthAccount.emailAddress (modern Claude Code CLI format)
      if (data?.oauthAccount?.emailAddress && typeof data.oauthAccount.emailAddress === 'string') {
        return data.oauthAccount.emailAddress;
      }
    } catch (error) {
      console.warn(`[profile-utils] Failed to read email from ${claudeJsonPath}:`, error);
    }
  }

  // Fallback: check .credentials.json (used on some Linux setups)
  const credentialsJsonPath = join(expandedConfigDir, '.credentials.json');
  if (existsSync(credentialsJsonPath)) {
    try {
      const content = readFileSync(credentialsJsonPath, 'utf-8');
      const data = JSON.parse(content);

      // Check claudeAiOauth.email or emailAddress
      const email = data?.claudeAiOauth?.email || data?.claudeAiOauth?.emailAddress || data?.email;
      if (email && typeof email === 'string') {
        return email;
      }
    } catch (error) {
      console.warn(`[profile-utils] Failed to read email from ${credentialsJsonPath}:`, error);
    }
  }

  return null;
}

/**
 * Whether an account signs in with a Claude subscription (usage, limits and re-authentication
 * apply); a detected setup on a cloud provider, an API key or a gateway doesn't
 */
export function usesClaudeSubscription(profile: ClaudeProfile): boolean {
  return !profile.detected || profile.detected.provider === 'subscription';
}

/** The Claude account (and organization) a config dir is signed in to */
export interface ClaudeAccountIdentity {
  email: string | null;
  accountUuid: string | null;
  organizationUuid: string | null;
}

/**
 * Read which Claude account a config dir is signed in to, from `.claude.json` → `oauthAccount`.
 * Returns null when the dir isn't signed in (or the file can't be read).
 */
export function getAccountIdentityFromConfigDir(configDir?: string): ClaudeAccountIdentity | null {
  if (!configDir) return null;
  const claudeJsonPath = getClaudeGlobalConfigPath(configDir);
  if (!existsSync(claudeJsonPath)) return null;
  try {
    const account = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))?.oauthAccount;
    if (!account || typeof account !== 'object') return null;
    const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
    const identity: ClaudeAccountIdentity = {
      email: str(account.emailAddress)?.toLowerCase() ?? null,
      accountUuid: str(account.accountUuid),
      organizationUuid: str(account.organizationUuid),
    };
    return identity.email || identity.accountUuid ? identity : null;
  } catch {
    return null;
  }
}

/**
 * Whether two identities are the same Claude subscription: the same account (by account id, or
 * by email when an id is missing) in the same organization. One email can belong to several
 * organizations (personal and team plans), which are different subscriptions with their own
 * limits, so a known, different organization never matches.
 */
export function isSameClaudeAccount(a: ClaudeAccountIdentity | null, b: ClaudeAccountIdentity | null): boolean {
  if (!a || !b) return false;
  if (a.organizationUuid && b.organizationUuid && a.organizationUuid !== b.organizationUuid) return false;
  if (a.accountUuid && b.accountUuid) return a.accountUuid === b.accountUuid;
  return !!a.email && a.email === b.email;
}
