/**
 * Profile Storage Module
 * Handles persistence of profile data to disk
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { expandClaudeHome, joinClaudeHome } from '../platform/claude-home';
import type { ClaudeProfile } from '../../shared/types';

/** Claude Code's default ~/.claude (in the Linux home when Claude Code runs in WSL) */
const getDefaultClaudeConfigDir = () => joinClaudeHome('.claude');
/** The app's isolated profile dirs (~/.claude-profiles) */
const getClaudeProfilesDir = () => joinClaudeHome('.claude-profiles');

const STORE_VERSION = 3;  // Bumped for encrypted token storage

/**
 * Internal storage format for Claude profiles
 */
export interface ProfileStoreData {
  version: number;
  profiles: ClaudeProfile[];
  activeProfileId: string;
  /**
   * Profile IDs that were migrated from shared ~/.claude to isolated directories.
   * These profiles need re-authentication since their credentials are in the old location.
   * Cleared after successful re-authentication.
   */
  migratedProfileIds?: string[];
}

/**
 * Check if a profile uses the legacy shared ~/.claude directory
 */
function usesLegacySharedDirectory(profile: ClaudeProfile): boolean {
  // A detected Claude Code setup is Claude Code's own dir, used as it is
  if (!profile.configDir || profile.detected) return false;

  // Normalize paths for comparison
  const normalizedConfigDir = profile.configDir.startsWith('~')
    ? expandClaudeHome(profile.configDir)
    : profile.configDir;

  return normalizedConfigDir === getDefaultClaudeConfigDir();
}

/**
 * Migrate a profile from shared ~/.claude to isolated ~/.claude-profiles/{name}
 * Returns the new configDir path
 *
 * Handles directory collisions by appending a counter (e.g., 'work-account-2')
 * when two profile names sanitize to the same value.
 */
function migrateProfileToIsolatedDirectory(profile: ClaudeProfile): string {
  // Generate isolated directory name from profile name
  const baseName = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'primary';

  // Ensure the profiles directory exists
  const profilesDir = getClaudeProfilesDir();
  if (!existsSync(profilesDir)) {
    mkdirSync(profilesDir, { recursive: true });
  }

  // Check for directory collision and append counter if needed
  let sanitizedName = baseName;
  let counter = 1;
  let isolatedDir = join(profilesDir, sanitizedName);

  // Keep incrementing counter until we find an available directory name
  // Use profile.id as a marker file to detect if the directory belongs to this profile
  // NOTE: There's a TOCTOU race window between existsSync and readFileSync, but this is
  // acceptable because profile directory creation is infrequent and concurrent creation
  // is unlikely. The worst case is we increment the counter unnecessarily.
  while (existsSync(isolatedDir)) {
    const markerFile = join(isolatedDir, '.profile-id');
    if (existsSync(markerFile)) {
      try {
        const existingId = readFileSync(markerFile, 'utf-8').trim();
        if (existingId === profile.id) {
          // This directory belongs to us, use it
          break;
        }
      } catch {
        // Ignore read errors, treat as collision
      }
    }
    // Directory exists but belongs to different profile, try next counter
    counter++;
    sanitizedName = `${baseName}-${counter}`;
    isolatedDir = join(profilesDir, sanitizedName);
  }

  // Create the profile directory if it doesn't exist
  if (!existsSync(isolatedDir)) {
    mkdirSync(isolatedDir, { recursive: true });
  }

  // Write a marker file with our profile ID for collision detection
  // Use 'wx' flag to atomically create file only if it doesn't exist (avoids TOCTOU race)
  const markerFile = join(isolatedDir, '.profile-id');
  try {
    writeFileSync(markerFile, profile.id, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    // EEXIST means file already exists, which is fine - we already own this directory
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.warn('[ProfileStorage] Failed to write marker file:', err);
    }
  }

  console.warn(`[ProfileStorage] Migrated profile "${profile.name}" from ~/.claude to ${isolatedDir}`);
  console.warn('[ProfileStorage] NOTE: Credentials remain at ~/.claude - user should re-authenticate in Settings > Accounts');

  return isolatedDir;
}

/**
 * Parse and migrate profile data from JSON.
 * Handles version migration and date parsing.
 * Shared helper used by both sync and async loaders.
 */
function parseAndMigrateProfileData(data: Record<string, unknown>): ProfileStoreData | null {
  // Automatic account switching was removed: stores saved before keep its settings, dropped here
  delete data.autoSwitch;

  // Handle version migration
  if (data.version === 1) {
    // Migrate v1 to v2: add usage and rateLimitEvents fields
    data.version = STORE_VERSION;
  }

  if (data.version === STORE_VERSION) {
    // Track profiles that were migrated in this session
    const newlyMigratedProfileIds: string[] = [];

    // Parse dates and migrate profile data
    const profiles = data.profiles as ClaudeProfile[];
    data.profiles = profiles.map((p: ClaudeProfile) => {
      // MIGRATION: Clear cached oauthToken to prevent stale token issues
      // OAuth tokens expire in 8-12 hours. We now read fresh tokens from Keychain
      // instead of caching them. See: docs/LONG_LIVED_AUTH_PLAN.md
      if (p.oauthToken) {
        console.warn('[ProfileStorage] Migrating profile - removing cached oauthToken:', p.name);
      }

      // Destructure to remove oauthToken and tokenCreatedAt from the profile
      const { oauthToken: _, tokenCreatedAt: __, ...profileWithoutToken } = p;

      // MIGRATION: Move profiles from shared ~/.claude to isolated directories
      // This prevents interference with external Claude Code CLI usage
      let configDir = profileWithoutToken.configDir;
      if (usesLegacySharedDirectory(p)) {
        configDir = migrateProfileToIsolatedDirectory(p);
        // Track this profile as newly migrated (needs re-authentication)
        newlyMigratedProfileIds.push(p.id);
        console.warn('[ProfileStorage] Profile isolation migration:', {
          profileName: p.name,
          oldConfigDir: p.configDir,
          newConfigDir: configDir
        });
      }

      return {
        ...profileWithoutToken,
        configDir,  // Use migrated configDir
        createdAt: new Date(p.createdAt),
        lastUsedAt: p.lastUsedAt ? new Date(p.lastUsedAt) : undefined,
        usage: p.usage ? {
          ...p.usage,
          lastUpdated: new Date(p.usage.lastUpdated)
        } : undefined,
        rateLimitEvents: p.rateLimitEvents?.map(e => ({
          ...e,
          hitAt: new Date(e.hitAt),
          resetAt: new Date(e.resetAt)
        }))
      };
    });

    // Merge newly migrated profiles with any existing migratedProfileIds
    const existingMigrated = (data.migratedProfileIds as string[] | undefined) || [];
    const allMigratedIds = [...new Set([...existingMigrated, ...newlyMigratedProfileIds])];
    if (allMigratedIds.length > 0) {
      data.migratedProfileIds = allMigratedIds;
    }

    return data as unknown as ProfileStoreData;
  }

  return null;
}

/**
 * Load profiles from disk (async, non-blocking)
 * Use this version for initialization to avoid blocking the main process.
 */
export async function loadProfileStoreAsync(storePath: string): Promise<ProfileStoreData | null> {
  try {
    // Read file directly - avoid TOCTOU race condition by not checking existence first
    // If file doesn't exist, readFile will throw ENOENT which we handle below
    const content = await readFile(storePath, 'utf-8');
    const data = JSON.parse(content);
    return parseAndMigrateProfileData(data);
  } catch (error) {
    // ENOENT is expected if file doesn't exist yet
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[ProfileStorage] Error loading profiles:', error);
    }
  }

  return null;
}

/**
 * Save profiles to disk
 */
export function saveProfileStore(storePath: string, data: ProfileStoreData): void {
  try {
    writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('[ProfileStorage] Error saving profiles:', error);
  }
}
