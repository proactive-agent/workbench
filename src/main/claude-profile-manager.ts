/**
 * Claude Profile Manager
 * Main coordinator for multi-account profile management
 *
 * This class delegates to specialized modules:
 * - token-encryption: OAuth token encryption/decryption
 * - usage-parser: Usage data parsing and reset time calculations
 * - rate-limit-manager: Rate limit event tracking
 * - profile-storage: Disk persistence
 * - profile-utils: Helper utilities
 */

import { app } from 'electron';
import path, { join } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import type {
  ClaudeProfile,
  ClaudeProfileSettings,
  ClaudeUsageData,
  ClaudeRateLimitEvent
} from '../shared/types';

// Module imports
import { encryptToken, decryptToken } from './claude-profile/token-encryption';
import { parseUsageOutput } from './claude-profile/usage-parser';
import {
  recordRateLimitEvent as recordRateLimitEventImpl,
  isProfileRateLimited as isProfileRateLimitedImpl,
  clearRateLimitEvents as clearRateLimitEventsImpl,
  pruneRateLimitEvents,
  type RecordRateLimitOptions
} from './claude-profile/rate-limit-manager';
import {
  loadProfileStoreAsync,
  saveProfileStore,
  ProfileStoreData
} from './claude-profile/profile-storage';
import { getCredentialsFromKeychain, getKeychainServiceName, normalizeWindowsPath, updateProfileSubscriptionMetadata } from './claude-profile/credential-utils';
import {
  getClaudeProfilesDir,
  generateProfileId as generateProfileIdImpl,
  createProfileDirectory as createProfileDirectoryImpl,
  isProfileAuthenticated as isProfileAuthenticatedImpl,
  hasValidToken,
  expandHomePath,
  getEmailFromConfigDir,
  getAccountIdentityFromConfigDir,
  isSameClaudeAccount
} from './claude-profile/profile-utils';
import { debugLog } from '../shared/utils/debug-logger';
import { isWindows } from './platform';
import { expandClaudeHome, isClaudeHomeInWsl, joinClaudeHome } from './platform/claude-home';
import { whenShellRuntimeReady } from './platform/shell-runtime';
import { detectClaudeCodeSetups, detectedAccountName, type DetectedSetup } from './claude-profile/claude-code-detection';
import { getDefaultClaudeConfigDir } from './claude-profile/config-dir-paths';
import { appLog } from './app-logger';

/** Normalize a profile configDir for comparison (~ expansion, resolution, Windows case). */
function normalizeConfigDir(configDir: string): string {
  // In WSL the dirs are the Linux home's UNC paths
  const resolved = (isClaudeHomeInWsl() ? path.win32 : path).resolve(expandHomePath(configDir));
  return isWindows() ? resolved.toLowerCase() : resolved;
}

/**
 * The profile store file. Claude Code inside WSL has its own accounts (in the Linux home), so
 * they are kept in a store of their own: switching between native and WSL keeps each side's
 * accounts, active account and usage instead of dropping or remapping them.
 */
export function getProfileStoreFileName(inWsl: boolean): string {
  return inWsl ? 'claude-profiles.wsl.json' : 'claude-profiles.json';
}

/** Copy of an object without its undefined-valued keys. */
function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Merge a duplicate profile (same configDir) into the one being kept: the kept profile's
 * values win, and anything only the duplicate has is filled in.
 */
function mergeDuplicateProfile(kept: ClaudeProfile, duplicate: ClaudeProfile): ClaudeProfile {
  return {
    ...definedFields(duplicate),
    ...definedFields(kept),
    id: kept.id,
    isDefault: kept.isDefault || duplicate.isDefault,
  } as ClaudeProfile;
}

/** Display names compared the way a person would read them */
function sameName(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Manages Claude Code profiles for multi-account support.
 * Profiles are stored in the app's userData directory.
 * Each profile points to a separate Claude config directory.
 */
export class ClaudeProfileManager {
  private storePath: string;
  private configDir: string;
  private data: ProfileStoreData;
  private initialized: boolean = false;
  /** Set once the store for this session's runtime (native or WSL) is chosen; nothing is saved before */
  private storeReady: boolean = false;
  /** Called whenever the account in use changes, from any caller (Settings, terminals) */
  private activeProfileListeners = new Set<(profileId: string, previousProfileId: string) => void>();

  constructor() {
    this.configDir = join(app.getPath('userData'), 'config');
    this.storePath = join(this.configDir, getProfileStoreFileName(false));

    // DON'T do file I/O here - defer to async initialize()
    // Start with default data until initialized
    this.data = this.createDefaultData();
  }

  /**
   * Initialize the profile manager asynchronously (non-blocking)
   * This should be called at app startup via initializeClaudeProfileManager()
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('[ClaudeProfileManager] Starting initialization...');

    // Claude Code's accounts live where it runs (natively or inside WSL), known once startup
    // detection of the shell runtime has finished
    await whenShellRuntimeReady();
    const inWsl = isClaudeHomeInWsl();
    this.storePath = join(this.configDir, getProfileStoreFileName(inWsl));
    this.storeReady = true;

    // Ensure directory exists (async) - mkdir with recursive:true is idempotent
    await mkdir(this.configDir, { recursive: true });

    // Load existing data asynchronously
    const loadedData = await loadProfileStoreAsync(this.storePath);
    if (loadedData) {
      this.data = loadedData;
      debugLog('[ClaudeProfileManager] Loaded profile store with', this.data.profiles.length, 'profiles');
    } else {
      // Defaults for this runtime (the ones from the constructor point at the native home)
      if (inWsl) this.data = this.createDefaultData();
      debugLog('[ClaudeProfileManager] No existing profile store found, using defaults');
    }

    // Claude Code's own setups (~/.claude, CLAUDE_CONFIG_DIR, ~/.claude-*) are the accounts
    this.syncDetectedAccounts();
    this.keepOnlyDetectedAccounts();

    // Run one-time migration to fix corrupted emails
    // This repairs emails that were truncated due to ANSI escape codes in terminal output
    this.migrateCorruptedEmails();

    // Remove duplicate profiles sharing the same configDir
    // Keeps the first (oldest/default) entry per configDir
    this.deduplicateProfiles();

    // Remove leftovers of sign-ins that never finished and that duplicate another account
    this.removeAbandonedDuplicates();

    // Forget rate limits that were never real (quoted limit messages) or have reset
    this.pruneStaleRateLimits();

    // Never stay on an account that can't sign in when one that can exists
    this.ensureUsableActiveProfile();

    // Populate missing subscription metadata for existing profiles
    // This reads subscriptionType and rateLimitTier from Keychain credentials
    this.populateSubscriptionMetadata();

    this.initialized = true;
    console.log('[ClaudeProfileManager] Initialization complete');
  }

  /**
   * List the Claude Code setups found on this machine as accounts (on every start): new ones are
   * added, known ones get their current values, and accounts whose setup is gone are dropped.
   * An account the user added for the same config dir becomes the detected one.
   */
  private syncDetectedAccounts(): void {
    let setups: DetectedSetup[];
    try {
      setups = detectClaudeCodeSetups({
        excludeUnder: [getClaudeProfilesDir()],
        hasSubscriptionCredentials: (dir) => !!getCredentialsFromKeychain(dir).token,
        keychainEntry: (dir) => getKeychainServiceName(dir),
      });
    } catch (error) {
      console.warn('[ClaudeProfileManager] Could not detect Claude Code accounts:', error);
      return;
    }

    const pending = new Map(setups.map((setup) => [normalizeConfigDir(setup.configDir), setup]));
    const toDetected = ({ configDir: _, ...detected }: DetectedSetup) => detected;
    let changed = false;

    this.data.profiles = this.data.profiles.filter((profile) => {
      const key = profile.configDir ? normalizeConfigDir(profile.configDir) : undefined;
      const setup = key ? pending.get(key) : undefined;
      if (setup && key) {
        pending.delete(key);
        profile.detected = toDetected(setup);
        if (setup.email) profile.email = setup.email;
        changed = true;
        return true;
      }
      if (profile.detected) {
        // Its setup no longer reaches Claude
        changed = true;
        return false;
      }
      return true;
    });

    for (const setup of pending.values()) {
      const taken = new Set(this.data.profiles.map((p) => p.name));
      const base = detectedAccountName(setup);
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
      this.data.profiles.push({
        id: generateProfileIdImpl(name, this.data.profiles),
        name,
        configDir: setup.configDir,
        isDefault: false,
        createdAt: new Date(),
        ...(setup.email ? { email: setup.email } : {}),
        detected: toDetected(setup),
      });
      changed = true;
    }

    if (changed) this.save();
  }

  /**
   * Only Claude Code's own setups are accounts. Accounts added the old way (each in its own
   * folder under ~/.claude-profiles) leave the list once a setup is detected; their folders stay.
   * References to a removed account move to the detected account of the same Claude account, or
   * to the one on Claude Code's default ~/.claude.
   */
  private keepOnlyDetectedAccounts(): void {
    const detected = this.data.profiles.filter((profile) => profile.detected);
    if (this.data.profiles.length === 0) {
      // Every setup is gone: the default account until a sign-in adds one
      const { profiles, activeProfileId } = this.createDefaultData();
      this.data.profiles = profiles;
      this.data.activeProfileId = activeProfileId;
      this.save();
      return;
    }
    if (detected.length === 0 || detected.length === this.data.profiles.length) return;

    const fallback = detected.find((profile) => profile.detected?.isDefaultDir) ?? detected[0];
    const idRemap = new Map<string, string>();
    for (const profile of this.data.profiles) {
      if (profile.detected) continue;
      const email = profile.email?.toLowerCase();
      const same = email ? detected.find((candidate) => candidate.email?.toLowerCase() === email) : undefined;
      idRemap.set(profile.id, (same ?? fallback).id);
    }

    this.data.profiles = detected;
    if (!detected.some((profile) => profile.isDefault)) fallback.isDefault = true;
    this.remapRemovedProfiles(idRemap);
    this.save();
  }

  /**
   * Config dir that Claude Code's own sign-in (`claude auth login`) writes an account to: the
   * account's own (to sign it in again); for a new account Claude Code's default ~/.claude while
   * no setup uses it, then ~/.claude-2, ~/.claude-3, ... (Claude Code's way of keeping several
   * accounts). Detection lists it afterwards.
   */
  getLoginConfigDir(profileId?: string): string {
    const profile = profileId ? this.getProfile(profileId) : undefined;
    if (profile?.detected && profile.configDir) return expandHomePath(profile.configDir);

    const used = new Set(
      this.data.profiles.filter((p) => p.detected && p.configDir).map((p) => normalizeConfigDir(p.configDir!))
    );
    const defaultDir = getDefaultClaudeConfigDir();
    if (!used.has(normalizeConfigDir(defaultDir))) return defaultDir;
    for (let n = 2; ; n++) {
      const dir = joinClaudeHome(`.claude-${n}`);
      if (!used.has(normalizeConfigDir(dir)) && !existsSync(dir)) return dir;
    }
  }

  /** Detect Claude Code's setups again (after a sign-in) and return the accounts */
  redetectAccounts(): ClaudeProfileSettings {
    this.syncDetectedAccounts();
    this.keepOnlyDetectedAccounts();
    this.ensureUsableActiveProfile();
    return this.getSettings();
  }

  /**
   * One-time migration to fix emails that were corrupted by ANSI escape codes
   * during terminal output parsing.
   *
   * This reads the authoritative email from Claude's config file (.claude.json)
   * for each profile and updates any that differ from what we have stored.
   */
  private migrateCorruptedEmails(): void {
    let needsSave = false;

    for (const profile of this.data.profiles) {
      if (!profile.configDir) {
        continue;
      }

      const configEmail = getEmailFromConfigDir(profile.configDir);

      if (configEmail && profile.email !== configEmail) {
        console.warn('[ClaudeProfileManager] Migrating corrupted email for profile:', {
          profileId: profile.id,
          oldEmail: profile.email,
          newEmail: configEmail
        });
        profile.email = configEmail;
        needsSave = true;
      }
    }

    if (needsSave) {
      this.save();
      console.warn('[ClaudeProfileManager] Email migration complete');
    }
  }

  /**
   * Remove duplicate profiles that share the same configDir (compared after normalization).
   * The first entry per configDir is kept; data that only a duplicate has (default flag,
   * OAuth token, email, subscription info, usage) is merged into it. The active profile and
   * provider accounts that referenced a removed id are remapped to the kept profile.
   */
  private deduplicateProfiles(): void {
    const keptIndexByDir = new Map<string, number>();
    const idRemap = new Map<string, string>(); // removed id -> kept id
    const kept: ClaudeProfile[] = [];

    for (const profile of this.data.profiles) {
      const key = profile.configDir ? normalizeConfigDir(profile.configDir) : undefined;
      const existingIndex = key ? keptIndexByDir.get(key) : undefined;
      if (key === undefined || existingIndex === undefined) {
        if (key !== undefined) keptIndexByDir.set(key, kept.length);
        kept.push(profile);
        continue;
      }
      const survivor = kept[existingIndex];
      kept[existingIndex] = mergeDuplicateProfile(survivor, profile);
      idRemap.set(profile.id, survivor.id);
    }

    if (idRemap.size === 0) return;

    this.data.profiles = kept;
    this.remapRemovedProfiles(idRemap);

    debugLog(`[ClaudeProfileManager] Deduplicated profiles: removed ${idRemap.size} duplicates, ${kept.length} remaining`);
    this.save();
  }

  /**
   * Point references to removed profiles (the active profile) at the
   * profiles that replaced them. Callers remove the profiles themselves and save.
   */
  private remapRemovedProfiles(idRemap: Map<string, string>): void {
    const remapId = (id: string): string => idRemap.get(id) ?? id;

    if (this.data.activeProfileId) {
      this.data.activeProfileId = remapId(this.data.activeProfileId);
    }

    if (this.data.migratedProfileIds) {
      this.data.migratedProfileIds = this.data.migratedProfileIds.filter(id => !idRemap.has(id));
      if (this.data.migratedProfileIds.length === 0) delete this.data.migratedProfileIds;
    }
  }

  /**
   * Whether a profile is the leftover of an "Add account" sign-in that never finished: not the
   * default account, no email, not signed in (no credentials for its config dir).
   */
  private isAbandonedSignIn(profile: ClaudeProfile): boolean {
    return !profile.isDefault
      && !profile.detected
      && !profile.email
      && !hasValidToken(profile)
      && !this.isProfileAuthenticated(profile)
      && !getAccountIdentityFromConfigDir(profile.configDir);
  }

  /**
   * Remove abandoned sign-ins (see isAbandonedSignIn) that carry the same name as another
   * account that is signed in or has an email: they are duplicates of that account (for example
   * "Primary" again, created as `primary-1` by a sign-in that was interrupted) and can never be
   * used. References to them move to that account. Their config dirs are left on disk.
   */
  private removeAbandonedDuplicates(): void {
    const idRemap = new Map<string, string>();
    for (const profile of this.data.profiles) {
      if (!this.isAbandonedSignIn(profile)) continue;
      const original = this.data.profiles.find(other =>
        other.id !== profile.id
        && !idRemap.has(other.id)
        && sameName(other.name, profile.name)
        && (!!other.email || this.isProfileAuthenticated(other))
      );
      if (original) idRemap.set(profile.id, original.id);
    }
    if (idRemap.size === 0) return;

    this.data.profiles = this.data.profiles.filter(p => !idRemap.has(p.id));
    this.remapRemovedProfiles(idRemap);
    console.warn('[ClaudeProfileManager] Removed duplicate accounts that were never signed in:', Object.fromEntries(idRemap));
    this.save();
  }

  /** Drop rate limit events that were never real or whose reset time has passed */
  private pruneStaleRateLimits(): void {
    let changed = false;
    for (const profile of this.data.profiles) {
      if (pruneRateLimitEvents(profile)) changed = true;
    }
    if (changed) {
      debugLog('[ClaudeProfileManager] Removed stale or implausible rate limit events');
      this.save();
    }
  }

  /**
   * If the active profile can't sign in (no credentials) but another profile can, switch to
   * that one (the default account first, then list order).
   */
  private ensureUsableActiveProfile(): void {
    const active = this.data.profiles.find(p => p.id === this.data.activeProfileId);
    if (active && this.hasValidAuth(active.id)) return;

    const usable = this.data.profiles.filter(p => this.hasValidAuth(p.id));
    const replacement = usable.find(p => p.isDefault) ?? usable[0];
    if (!replacement || replacement.id === this.data.activeProfileId) return;

    console.warn('[ClaudeProfileManager] Active account is not signed in, switching to a signed-in account:', {
      from: this.data.activeProfileId,
      to: replacement.id
    });
    this.data.activeProfileId = replacement.id;
    this.save();
  }

  /**
   * An unfinished sign-in profile with this name (see isAbandonedSignIn), to reuse when an
   * account with the same name is added again instead of creating `<name>-1`.
   */
  findAbandonedProfileByName(name: string): ClaudeProfile | undefined {
    return this.data.profiles.find(p => sameName(p.name, name) && this.isAbandonedSignIn(p));
  }

  /** A profile with this display name (case-insensitive) */
  findProfileByName(name: string): ClaudeProfile | undefined {
    return this.data.profiles.find(p => sameName(p.name, name));
  }

  /**
   * After a profile signed in: if another profile is signed in to the same Claude account (same
   * account and organization), keep a single entry. The older entry stays (its id, name,
   * default flag and place in the list); it takes the newly signed-in config dir when its own
   * has no credentials. Returns the profile that remains, or null when there was no duplicate.
   */
  mergeSameAccountProfile(profileId: string): ClaudeProfile | null {
    const profile = this.getProfile(profileId);
    if (!profile) return null;
    const identity = getAccountIdentityFromConfigDir(profile.configDir);
    if (!identity) return null;

    const twin = this.data.profiles.find(other =>
      other.id !== profile.id && isSameClaudeAccount(identity, getAccountIdentityFromConfigDir(other.configDir))
    );
    if (!twin) return null;

    const profileIndex = this.data.profiles.indexOf(profile);
    const twinIndex = this.data.profiles.indexOf(twin);
    const [older, newer] = twinIndex < profileIndex ? [twin, profile] : [profile, twin];
    const olderSignedIn = this.isProfileAuthenticated(older);

    const merged = mergeDuplicateProfile(
      {
        ...older,
        ...(olderSignedIn ? {} : {
          configDir: newer.configDir,
          email: newer.email ?? older.email,
          subscriptionType: newer.subscriptionType ?? older.subscriptionType,
          rateLimitTier: newer.rateLimitTier ?? older.rateLimitTier,
        }),
      },
      newer
    );
    this.data.profiles[this.data.profiles.indexOf(older)] = merged;
    this.data.profiles = this.data.profiles.filter(p => p.id !== newer.id);
    this.remapRemovedProfiles(new Map([[newer.id, older.id]]));
    console.warn('[ClaudeProfileManager] Account was already added, kept one entry:', { kept: older.id, removed: newer.id });
    this.save();
    return merged;
  }

  /**
   * Populate missing subscription metadata (subscriptionType, rateLimitTier) for existing profiles.
   *
   * This reads from Keychain credentials and updates profiles that don't have this metadata.
   * Runs on initialization to ensure existing profiles get the subscription info for UI display.
   */
  private populateSubscriptionMetadata(): void {
    let needsSave = false;

    debugLog('[ClaudeProfileManager] populateSubscriptionMetadata: checking', this.data.profiles.length, 'profiles');

    for (const profile of this.data.profiles) {
      if (!profile.configDir) {
        debugLog('[ClaudeProfileManager] populateSubscriptionMetadata: skipping profile', profile.id, '(no configDir)');
        continue;
      }

      // Skip if profile already has subscription metadata
      if (profile.subscriptionType && profile.rateLimitTier) {
        debugLog('[ClaudeProfileManager] populateSubscriptionMetadata: profile', profile.id, 'already has metadata:', {
          subscriptionType: profile.subscriptionType,
          rateLimitTier: profile.rateLimitTier
        });
        continue;
      }

      // Expand ~ to home directory
      const expandedConfigDir = normalizeWindowsPath(
        expandClaudeHome(profile.configDir)
      );

      // Use helper with onlyIfMissing option to preserve existing values
      const result = updateProfileSubscriptionMetadata(profile, expandedConfigDir, { onlyIfMissing: true });

      if (result.subscriptionTypeUpdated) {
        needsSave = true;
        console.warn('[ClaudeProfileManager] Populated subscriptionType for profile:', {
          profileId: profile.id,
          subscriptionType: result.subscriptionType
        });
      }

      if (result.rateLimitTierUpdated) {
        needsSave = true;
        console.warn('[ClaudeProfileManager] Populated rateLimitTier for profile:', {
          profileId: profile.id,
          rateLimitTier: result.rateLimitTier
        });
      }
    }

    if (needsSave) {
      this.save();
      console.warn('[ClaudeProfileManager] Subscription metadata population complete');
    }
  }

  /**
   * Check if the profile manager has been initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Create default profile data
   *
   * IMPORTANT: New profiles use isolated directories (~/.claude-profiles/{name})
   * to prevent interference with external Claude Code CLI usage.
   * The profile name is used as the directory name (sanitized to lowercase).
   */
  private createDefaultData(): ProfileStoreData {
    // Use an isolated directory for the initial profile
    // This prevents interference with external Claude Code CLI which uses ~/.claude
    const initialProfileName = 'Primary';
    const sanitizedName = initialProfileName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const isolatedConfigDir = join(getClaudeProfilesDir(), sanitizedName);

    const defaultProfile: ClaudeProfile = {
      id: sanitizedName,  // Use sanitized name as ID (e.g., 'primary')
      name: initialProfileName,
      configDir: isolatedConfigDir,
      isDefault: true,  // First profile is the default
      description: 'Primary Claude account',
      createdAt: new Date()
    };

    return {
      version: 3,
      profiles: [defaultProfile],
      activeProfileId: sanitizedName
    };
  }

  /**
   * Save profiles to disk
   */
  private save(): void {
    // Before initialize() picks this runtime's store, the data are only defaults
    if (!this.storeReady) return;
    saveProfileStore(this.storePath, this.data);
  }

  /**
   * Get all profiles and settings
   * Computes isAuthenticated for each profile by checking configDir credentials
   */
  getSettings(): ClaudeProfileSettings {
    // Compute isAuthenticated for each profile
    const profilesWithAuth = this.data.profiles.map(profile => ({
      ...profile,
      isAuthenticated: this.isProfileAuthenticated(profile) || hasValidToken(profile)
    }));

    return {
      profiles: profilesWithAuth,
      activeProfileId: this.data.activeProfileId
    };
  }

  /**
   * The profiles' Claude Code config dirs (as stored), without checking their credentials
   */
  getProfileConfigDirs(): string[] {
    return this.data.profiles.flatMap(profile => (profile.configDir ? [profile.configDir] : []));
  }

  /**
   * Get a specific profile by ID
   */
  getProfile(profileId: string): ClaudeProfile | undefined {
    return this.data.profiles.find(p => p.id === profileId);
  }

  /**
   * Get the active profile
   */
  getActiveProfile(): ClaudeProfile {
    const active = this.data.profiles.find(p => p.id === this.data.activeProfileId);
    if (!active) {
      // Fallback to default
      const defaultProfile = this.data.profiles.find(p => p.isDefault);
      if (defaultProfile) {
        if (process.env.VERBOSE === 'true') {
          console.warn('[ClaudeProfileManager] getActiveProfile - using default:', {
            id: defaultProfile.id,
            name: defaultProfile.name,
            email: defaultProfile.email
          });
        }
        return defaultProfile;
      }
      // If somehow no default exists, return first profile
      const fallback = this.data.profiles[0];
      if (process.env.VERBOSE === 'true') {
        console.warn('[ClaudeProfileManager] getActiveProfile - using fallback:', {
          id: fallback.id,
          name: fallback.name,
          email: fallback.email
        });
      }
      return fallback;
    }

    if (process.env.VERBOSE === 'true') {
      console.warn('[ClaudeProfileManager] getActiveProfile:', {
        id: active.id,
        name: active.name,
        email: active.email
      });
    }

    return active;
  }

  /**
   * Save or update a profile.
   *
   * Deduplication: If a profile with the same configDir already exists (but
   * a different ID), we update the existing entry instead of creating a
   * duplicate. This prevents the profile store from growing unboundedly
   * when the UI generates new IDs for the same underlying account.
   */
  saveProfile(profile: ClaudeProfile): ClaudeProfile {
    // Expand ~ in configDir path
    if (profile.configDir) {
      profile.configDir = expandHomePath(profile.configDir);
    }

    // First, try exact ID match (normal update path)
    const indexById = this.data.profiles.findIndex(p => p.id === profile.id);

    if (indexById >= 0) {
      // Update existing profile by ID
      this.data.profiles[indexById] = profile;
      this.save();
      return profile;
    }

    // No ID match — check for configDir duplicate before adding. Same configDir means the
    // same credentials, so update the existing entry (keeping its id and any data the
    // incoming skeleton doesn't carry) instead of creating a duplicate.
    if (profile.configDir) {
      const dir = normalizeConfigDir(profile.configDir);
      const indexByConfigDir = this.data.profiles.findIndex(
        p => p.configDir !== undefined && normalizeConfigDir(p.configDir) === dir
      );

      if (indexByConfigDir >= 0) {
        const existing = this.data.profiles[indexByConfigDir];
        debugLog('[ClaudeProfileManager] Dedup: profile with configDir already exists, updating instead of adding', {
          existingId: existing.id,
          incomingId: profile.id,
          configDir: profile.configDir,
        });
        const merged = mergeDuplicateProfile(
          { ...existing, ...definedFields(profile), id: existing.id, createdAt: existing.createdAt },
          existing
        );
        this.data.profiles[indexByConfigDir] = merged;
        this.save();
        return merged;
      }
    }

    // Genuinely new profile — add it
    this.data.profiles.push(profile);
    this.save();
    return profile;
  }

  /**
   * Delete a profile (cannot delete default or last profile)
   */
  deleteProfile(profileId: string): boolean {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return false;
    }

    // Cannot delete default profile, nor an account found in Claude Code's configuration
    if (profile.isDefault || profile.detected) {
      return false;
    }

    // Cannot delete if it's the only profile
    if (this.data.profiles.length <= 1) {
      return false;
    }

    // Remove the profile
    this.data.profiles = this.data.profiles.filter(p => p.id !== profileId);

    // If we deleted the active profile, switch to default
    if (this.data.activeProfileId === profileId) {
      const defaultProfile = this.data.profiles.find(p => p.isDefault);
      this.data.activeProfileId = defaultProfile?.id || this.data.profiles[0].id;
    }

    this.save();
    return true;
  }

  /**
   * Why an account found in Claude Code's configuration can't be deleted, or null when it can:
   * not the account in use (unless `replacementId` names another account to take its place for
   * the projects without their own: a window on another account deletes it), not the only account,
   * and not set up from outside its config dir (environment variables or managed settings, which
   * would list it again)
   */
  detectedAccountDeletionBlocker(profileId: string, replacementId?: string): string | null {
    const profile = this.getProfile(profileId);
    if (!profile) return 'Account not found';
    if (!profile.detected || !profile.configDir) return "Not an account from Claude Code's configuration";
    if (profile.id === this.data.activeProfileId && (!replacementId || replacementId === profileId || !this.getProfile(replacementId))) {
      return "The account in use can't be deleted";
    }
    if (this.data.profiles.length <= 1) return "The only Claude account can't be deleted";
    if (profile.detected.isDefaultDir && profile.detected.definedOutside) {
      return 'This account is set up by environment variables or managed settings outside Claude Code\'s config dir; remove them there';
    }
    return null;
  }

  /**
   * Drop a deleted account (see account-deletion.ts, which removed its files) from the accounts.
   * References to it move to the account in use.
   */
  removeDetectedAccount(profileId: string): void {
    const others = this.data.profiles.filter((p) => p.id !== profileId);
    if (others.length === this.data.profiles.length || others.length === 0) return;
    const removed = this.data.profiles.find((p) => p.id === profileId)!;
    this.data.profiles = others;
    const fallback = others.find((p) => p.id === this.data.activeProfileId)
      ?? others.find((p) => p.detected?.isDefaultDir) ?? others[0];
    if (removed.isDefault && !others.some((p) => p.isDefault)) fallback.isDefault = true;
    this.remapRemovedProfiles(new Map([[profileId, fallback.id]]));
    this.save();
  }

  /**
   * Rename a profile
   */
  renameProfile(profileId: string, newName: string): boolean {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return false;
    }

    // Cannot rename to empty name
    if (!newName.trim()) {
      return false;
    }

    profile.name = newName.trim();
    this.save();
    return true;
  }

  /**
   * Set the active profile
   */
  setActiveProfile(profileId: string): boolean {
    const previousProfileId = this.data.activeProfileId;
    const profile = this.getProfile(profileId);
    if (!profile) {
      console.warn('[ClaudeProfileManager] setActiveProfile failed - profile not found:', { profileId });
      return false;
    }

    if (process.env.DEBUG === 'true') {
      console.warn('[ClaudeProfileManager] setActiveProfile:', {
        from: previousProfileId,
        to: profileId,
        profileName: profile.name
      });
    }

    this.data.activeProfileId = profileId;
    profile.lastUsedAt = new Date();
    this.save();
    if (previousProfileId !== profileId) {
      for (const listener of this.activeProfileListeners) {
        try {
          listener(profileId, previousProfileId);
        } catch (error) {
          appLog.warn('[ClaudeProfileManager] Active profile listener failed:', error);
        }
      }
    }
    return true;
  }

  /** Listen for the account in use changing; returns the unsubscribe function */
  onActiveProfileChanged(listener: (profileId: string, previousProfileId: string) => void): () => void {
    this.activeProfileListeners.add(listener);
    return () => { this.activeProfileListeners.delete(listener); };
  }

  /**
   * Update last used timestamp for a profile
   */
  markProfileUsed(profileId: string): void {
    const profile = this.getProfile(profileId);
    if (profile) {
      profile.lastUsedAt = new Date();
      this.save();
    }
  }

  /**
   * Get the OAuth token for the active profile (decrypted).
   * Returns undefined if no token is set (profile needs authentication).
   */
  getActiveProfileToken(): string | undefined {
    const profile = this.getActiveProfile();
    if (!profile?.oauthToken) {
      return undefined;
    }
    // Decrypt the token before returning
    return decryptToken(profile.oauthToken);
  }

  /**
   * Get the decrypted OAuth token for a specific profile.
   */
  getProfileToken(profileId: string): string | undefined {
    const profile = this.getProfile(profileId);
    if (!profile?.oauthToken) {
      return undefined;
    }
    return decryptToken(profile.oauthToken);
  }

  /**
   * Set the OAuth token for a profile (encrypted storage).
   * Used when capturing token from `claude setup-token` output.
   */
  setProfileToken(profileId: string, token: string, email?: string): boolean {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return false;
    }

    // Encrypt the token before storing
    profile.oauthToken = encryptToken(token);
    profile.tokenCreatedAt = new Date();
    if (email) {
      profile.email = email;
    }

    // Clear any rate limit events since this might be a new account
    profile.rateLimitEvents = [];

    this.save();
    return true;
  }

  /**
   * Check if a profile has a valid OAuth token.
   * Token is valid for 1 year from creation.
   */
  hasValidToken(profileId: string): boolean {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return false;
    }
    return hasValidToken(profile);
  }

  /**
   * Get environment variables for spawning processes with the active profile.
   *
   * IMPORTANT: Always uses CLAUDE_CONFIG_DIR to let Claude CLI read fresh tokens from Keychain.
   * We NEVER use cached OAuth tokens (CLAUDE_CODE_OAUTH_TOKEN) because:
   * 1. OAuth tokens expire in 8-12 hours
   * 2. Claude CLI's token refresh mechanism works (updates Keychain)
   * 3. Cached tokens don't benefit from Claude CLI's automatic refresh
   * 4. CLAUDE_CODE_OAUTH_TOKEN doesn't include subscription tier info
   *
   * By using CLAUDE_CONFIG_DIR, Claude CLI reads fresh tokens from Keychain each time,
   * which includes any refreshed tokens and full credential metadata.
   *
   * See: docs/LONG_LIVED_AUTH_PLAN.md for full context.
   */
  getActiveProfileEnv(): Record<string, string> {
    const profile = this.getActiveProfile();
    const env: Record<string, string> = {};

    // All profiles now use explicit CLAUDE_CONFIG_DIR for isolation
    // This prevents interference with external Claude Code CLI usage
    if (profile?.configDir) {
      // Expand ~ to home directory for the environment variable
      const expandedConfigDir = normalizeWindowsPath(
        expandClaudeHome(profile.configDir)
      );

      env.CLAUDE_CONFIG_DIR = expandedConfigDir;
      if (process.env.VERBOSE === 'true') {
        console.warn('[ClaudeProfileManager] Using CLAUDE_CONFIG_DIR for profile:', profile.name, expandedConfigDir);
      }
    } else if (profile) {
      // Fallback: retrieve OAuth token directly from Keychain when configDir is missing.
      // Without configDir, Claude CLI cannot resolve credentials automatically,
      // so we inject CLAUDE_CODE_OAUTH_TOKEN as a direct override.
      debugLog(
        '[ClaudeProfileManager] Profile has no configDir configured:',
        profile.name,
        '- falling back to Keychain token lookup. Subscription display may be degraded.'
      );

      const credentials = getCredentialsFromKeychain(undefined, true);
      if (credentials.token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = credentials.token;
        debugLog('[ClaudeProfileManager] Injected CLAUDE_CODE_OAUTH_TOKEN from Keychain for profile:', profile.name);
      } else {
        debugLog(
          '[ClaudeProfileManager] No token found in Keychain for profile without configDir:',
          profile.name,
          credentials.error ? `(error: ${credentials.error})` : ''
        );
      }
    }

    return env;
  }

  /**
   * Update usage data for a profile (parsed from /usage output)
   */
  updateProfileUsage(profileId: string, usageOutput: string): ClaudeUsageData | null {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return null;
    }

    const usage = parseUsageOutput(usageOutput);
    profile.usage = usage;
    this.save();
    return usage;
  }

  /**
   * Update usage data for a profile from API response (percentages directly)
   * This is called by the usage monitor after fetching usage via the API
   */
  updateProfileUsageFromAPI(profileId: string, sessionPercent: number, weeklyPercent: number): ClaudeUsageData | null {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return null;
    }

    // Preserve existing reset times if available, otherwise use empty string
    const existingUsage = profile.usage;
    const usage: ClaudeUsageData = {
      sessionUsagePercent: sessionPercent,
      sessionResetTime: existingUsage?.sessionResetTime ?? '',
      weeklyUsagePercent: weeklyPercent,
      weeklyResetTime: existingUsage?.weeklyResetTime ?? '',
      opusUsagePercent: existingUsage?.opusUsagePercent,
      lastUpdated: new Date()
    };
    profile.usage = usage;
    this.save();
    return usage;
  }

  /**
   * Batch update usage data for multiple profiles from API responses.
   * Updates all profiles in memory first, then saves once to avoid race conditions.
   *
   * @param updates - Array of { profileId, sessionPercent, weeklyPercent } objects
   * @returns Number of profiles successfully updated
   */
  batchUpdateProfileUsageFromAPI(
    updates: Array<{ profileId: string; sessionPercent: number; weeklyPercent: number }>
  ): number {
    let updatedCount = 0;

    for (const { profileId, sessionPercent, weeklyPercent } of updates) {
      const profile = this.getProfile(profileId);
      if (!profile) {
        continue;
      }

      // Preserve existing reset times if available
      const existingUsage = profile.usage;
      const usage: ClaudeUsageData = {
        sessionUsagePercent: sessionPercent,
        sessionResetTime: existingUsage?.sessionResetTime ?? '',
        weeklyUsagePercent: weeklyPercent,
        weeklyResetTime: existingUsage?.weeklyResetTime ?? '',
        opusUsagePercent: existingUsage?.opusUsagePercent,
        lastUpdated: new Date()
      };
      profile.usage = usage;
      updatedCount++;
    }

    // Single save after all updates
    if (updatedCount > 0) {
      this.save();
    }

    return updatedCount;
  }

  /**
   * Record a rate limit event for a profile
   */
  recordRateLimitEvent(
    profileId: string,
    resetTimeStr: string,
    options?: RecordRateLimitOptions
  ): ClaudeRateLimitEvent | null {
    const profile = this.getProfile(profileId);
    if (!profile) {
      throw new Error('Profile not found');
    }

    // Null when the reset string isn't a real Claude reset (e.g. quoted in terminal output)
    const event = recordRateLimitEventImpl(profile, resetTimeStr, options);
    if (!event) {
      debugLog('[ClaudeProfileManager] Ignored implausible rate limit for profile:', profileId, JSON.stringify(resetTimeStr));
      return null;
    }
    this.save();
    return event;
  }

  /**
   * Check if a profile is currently rate-limited
   */
  isProfileRateLimited(profileId: string): { limited: boolean; type?: 'session' | 'weekly'; resetAt?: Date } {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return { limited: false };
    }
    return isProfileRateLimitedImpl(profile);
  }

  /**
   * Generate a unique ID for a new profile
   */
  generateProfileId(name: string): string {
    return generateProfileIdImpl(name, this.data.profiles);
  }

  /**
   * Create a new profile directory and initialize it
   */
  async createProfileDirectory(profileName: string): Promise<string> {
    return createProfileDirectoryImpl(profileName);
  }

  /**
   * Check if a profile has valid authentication
   * (checks if the config directory has credential files)
   */
  isProfileAuthenticated(profile: ClaudeProfile): boolean {
    return isProfileAuthenticatedImpl(profile);
  }

  /**
   * Check if a profile has valid authentication for starting tasks.
   * A profile is considered authenticated if:
   * 1) It has a valid OAuth token (not expired), OR
   * 2) It has an authenticated configDir (credential files exist)
   *
   * @param profileId - Optional profile ID to check. If not provided, checks active profile.
   * @returns true if the profile can authenticate, false otherwise
   */
  hasValidAuth(profileId?: string): boolean {
    const profile = profileId ? this.getProfile(profileId) : this.getActiveProfile();
    if (!profile) {
      return false;
    }

    // Check 1: Profile has a valid OAuth token
    if (hasValidToken(profile)) {
      return true;
    }

    // Check 2 & 3: Profile has authenticated configDir (works for both default and non-default)
    if (this.isProfileAuthenticated(profile)) {
      return true;
    }

    return false;
  }

  /**
   * Get environment variables for invoking Claude with a specific profile.
   *
   * IMPORTANT: Always returns CLAUDE_CONFIG_DIR for the profile, even for the default profile.
   * This ensures that when we switch to a specific profile for rate limit recovery,
   * we use that profile's exact configDir credentials, not just whatever happens to be
   * at ~/.claude (which might belong to a different profile).
   *
   * The ~ path is expanded to the full home directory path.
   */
  getProfileEnv(profileId: string): Record<string, string> {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return {};
    }

    if (!profile.configDir) {
      // Fallback: retrieve OAuth token directly from Keychain when configDir is missing.
      // Without configDir, Claude CLI cannot resolve credentials automatically,
      // so we inject CLAUDE_CODE_OAUTH_TOKEN as a direct override.
      // This mirrors the fallback in getActiveProfileEnv().
      debugLog(
        '[ClaudeProfileManager] getProfileEnv: profile has no configDir:',
        profile.name,
        '- falling back to Keychain token lookup.'
      );

      const credentials = getCredentialsFromKeychain(undefined, true);
      if (credentials.token) {
        debugLog('[ClaudeProfileManager] getProfileEnv: injected CLAUDE_CODE_OAUTH_TOKEN from Keychain for profile:', profile.name);
        return { CLAUDE_CODE_OAUTH_TOKEN: credentials.token };
      }
      debugLog(
        '[ClaudeProfileManager] getProfileEnv: no token found in Keychain for profile without configDir:',
        profile.name
      );
      return {};
    }

    // Expand ~ to home directory for the environment variable
    const expandedConfigDir = normalizeWindowsPath(
      expandClaudeHome(profile.configDir)
    );

    if (process.env.VERBOSE === 'true') {
      console.warn('[ClaudeProfileManager] getProfileEnv:', {
        profileId,
        profileName: profile.name,
        isDefault: profile.isDefault,
        configDir: profile.configDir,
        expandedConfigDir
      });
    }

    // Retrieve OAuth token from Keychain and pass it to subprocess
    // This ensures the backend Python agent can authenticate even when
    // there's no .credentials.json file in the profile directory
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: expandedConfigDir
    };

    try {
      const credentials = getCredentialsFromKeychain(expandedConfigDir);
      if (credentials.token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = credentials.token;
        if (process.env.VERBOSE === 'true') {
          console.warn('[ClaudeProfileManager] Retrieved OAuth token from Keychain for profile:', profile.name);
        }
      }
    } catch (error) {
      console.error('[ClaudeProfileManager] Failed to retrieve credentials from Keychain:', error);
      // Continue without token - backend will fall back to other auth methods
    }

    return env;
  }

  /**
   * Clear rate limit events for a profile (e.g., when they've reset)
   */
  clearRateLimitEvents(profileId: string): void {
    const profile = this.getProfile(profileId);
    if (profile) {
      clearRateLimitEventsImpl(profile);
      this.save();
    }
  }

  /**
   * Get the list of profile IDs that were migrated from shared ~/.claude to isolated directories.
   * These profiles need re-authentication since their credentials are in the old location.
   */
  getMigratedProfileIds(): string[] {
    return this.data.migratedProfileIds || [];
  }

  /**
   * Clear a profile from the migrated list after successful re-authentication.
   * Called when the user completes re-authentication for a migrated profile.
   *
   * @param profileId - The profile ID to clear from the migrated list
   */
  clearMigratedProfile(profileId: string): void {
    if (!this.data.migratedProfileIds) {
      return;
    }

    this.data.migratedProfileIds = this.data.migratedProfileIds.filter(id => id !== profileId);

    // If list is empty, remove the property entirely
    if (this.data.migratedProfileIds.length === 0) {
      delete this.data.migratedProfileIds;
    }

    this.save();
    console.warn('[ClaudeProfileManager] Cleared migrated profile:', profileId);
  }

  /**
   * Check if a profile was migrated and needs re-authentication.
   *
   * @param profileId - The profile ID to check
   * @returns true if the profile was migrated and needs re-auth
   */
  isProfileMigrated(profileId: string): boolean {
    return this.data.migratedProfileIds?.includes(profileId) ?? false;
  }
}

// Singleton instance and initialization promise
let profileManager: ClaudeProfileManager | null = null;
let initPromise: Promise<ClaudeProfileManager> | null = null;

/**
 * Get the singleton Claude profile manager instance
 * Note: For async contexts, prefer initializeClaudeProfileManager() to ensure initialization
 */
export function getClaudeProfileManager(): ClaudeProfileManager {
  if (!profileManager) {
    profileManager = new ClaudeProfileManager();
  }
  return profileManager;
}

/**
 * Initialize and get the singleton Claude profile manager instance (async)
 * This ensures the profile manager is fully initialized before use.
 * Uses promise caching to prevent concurrent initialization.
 * The cached promise is reset on failure to allow retries after transient errors.
 */
export async function initializeClaudeProfileManager(): Promise<ClaudeProfileManager> {
  if (!profileManager) {
    profileManager = new ClaudeProfileManager();
  }

  // If already initialized, return immediately
  if (profileManager.isInitialized()) {
    return profileManager;
  }

  // If initialization is in progress, wait for it (promise caching)
  if (!initPromise) {
    initPromise = profileManager.initialize()
      .then(() => {
        return profileManager!;
      })
      .catch((error) => {
        // Reset cached promise on failure so retries can succeed
        // This allows recovery from transient errors (e.g., disk full, permission issues)
        initPromise = null;
        throw error;
      });
  }

  return initPromise;
}
