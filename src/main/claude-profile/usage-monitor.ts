/**
 * Usage Monitor - Claude account usage monitoring
 *
 * Fetches the usage of the account in use (and the other accounts, less often) for the usage
 * badge and the accounts list. It never switches accounts.
 *
 * Uses hybrid approach:
 * 1. Primary: Direct OAuth API (https://api.anthropic.com/api/oauth/usage)
 * 2. Fallback: CLI /usage command parsing
 */

import { EventEmitter } from 'events';
import { expandClaudeHome } from '../platform/claude-home';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { ClaudeUsageSnapshot, ProfileUsageSummary, AllProfilesUsage, type UsageSpendLimit } from '../../shared/types/agent';
import { loadProfilesFile } from '../services/profile/profile-manager';
import type { APIProfile } from '../../shared/types/profile';
import { detectProvider as sharedDetectProvider, type ApiProvider } from '../../shared/utils/provider-detection';
import { getCredentialsFromKeychain, clearKeychainCache } from './credential-utils';
import { reactiveTokenRefresh, ensureValidToken } from './token-refresh';
import { isProfileRateLimited } from './rate-limit-manager';
import { usesClaudeSubscription } from './profile-utils';
import { appLog } from '../app-logger';

// Re-export for backward compatibility
export type { ApiProvider };

/**
 * Create a safe fingerprint of a credential for debug logging.
 * Shows first 8 and last 4 characters, hiding the sensitive middle portion.
 * This is NOT for authentication - only for human-readable debug identification.
 *
 * @param credential - The credential (token or API key) to create a fingerprint for
 * @returns A safe fingerprint like "sk-ant-oa...xyz9" or "null" if no credential
 */
function getCredentialFingerprint(credential: string | null | undefined): string {
  if (!credential) return 'null';
  if (credential.length <= 16) return credential.slice(0, 4) + '...' + credential.slice(-2);
  return credential.slice(0, 8) + '...' + credential.slice(-4);
}

/**
 * Allowed domains for usage API requests.
 * Only these domains are permitted for outbound usage monitoring requests.
 */
const ALLOWED_USAGE_API_DOMAINS = new Set([
  'api.anthropic.com',
  'api.z.ai',
  'open.bigmodel.cn',
]);

/**
 * Provider usage endpoint configuration
 * Maps each provider to its usage monitoring endpoint path
 */
interface ProviderUsageEndpoint {
  provider: ApiProvider;
  usagePath: string;
}

const PROVIDER_USAGE_ENDPOINTS: readonly ProviderUsageEndpoint[] = [
  {
    provider: 'anthropic',
    usagePath: '/api/oauth/usage'
  },
  {
    provider: 'zai',
    usagePath: '/api/monitor/usage/quota/limit'
  },
  {
    provider: 'zhipu',
    usagePath: '/api/monitor/usage/quota/limit'
  }
] as const;

/**
 * Get usage endpoint URL for a provider
 * Constructs full usage endpoint URL from provider baseUrl and usage path
 *
 * @param provider - The provider type
 * @param baseUrl - The API base URL (e.g., 'https://api.z.ai/api/anthropic')
 * @returns Full usage endpoint URL or null if provider unknown
 *
 * @example
 * getUsageEndpoint('anthropic', 'https://api.anthropic.com')
 * // returns 'https://api.anthropic.com/api/oauth/usage'
 * getUsageEndpoint('zai', 'https://api.z.ai/api/anthropic')
 * // returns 'https://api.z.ai/api/monitor/usage/quota/limit'
 * getUsageEndpoint('unknown', 'https://example.com')
 * // returns null
 */
export function getUsageEndpoint(provider: ApiProvider, baseUrl: string): string | null {
  const isVerbose = process.env.VERBOSE === 'true';

  if (isVerbose) {
    console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] Constructing usage endpoint:', {
      provider,
      baseUrl
    });
  }

  const endpointConfig = PROVIDER_USAGE_ENDPOINTS.find(e => e.provider === provider);
  if (!endpointConfig) {
    if (isVerbose) {
      console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] Unknown provider - no endpoint configured:', {
        provider,
        availableProviders: PROVIDER_USAGE_ENDPOINTS.map(e => e.provider)
      });
    }
    return null;
  }

  if (isVerbose) {
    console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] Found endpoint config for provider:', {
      provider,
      usagePath: endpointConfig.usagePath
    });
  }

  try {
    const url = new URL(baseUrl);
    const originalPath = url.pathname;
    // Replace the path with the usage endpoint path
    url.pathname = endpointConfig.usagePath;

    // Note: quota/limit endpoint doesn't require query parameters
    // The model-usage and tool-usage endpoints would need time windows, but we're using quota/limit

    const finalUrl = url.toString();

    if (isVerbose) {
      console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] Successfully constructed endpoint:', {
        provider,
        originalPath,
        newPath: endpointConfig.usagePath,
        finalUrl
      });
    }

    return finalUrl;
  } catch (error) {
    console.error('[UsageMonitor] Invalid baseUrl for usage endpoint:', baseUrl);
    if (isVerbose) {
      console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] URL construction failed:', {
        baseUrl,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return null;
  }
}

/**
 * Detect API provider from baseUrl
 * Extracts domain and matches against known provider patterns
 *
 * @param baseUrl - The API base URL (e.g., 'https://api.z.ai/api/anthropic')
 * @returns The detected provider type ('anthropic' | 'zai' | 'zhipu' | 'unknown')
 *
 * @example
 * detectProvider('https://api.anthropic.com') // returns 'anthropic'
 * detectProvider('https://api.z.ai/api/anthropic') // returns 'zai'
 * detectProvider('https://open.bigmodel.cn/api/anthropic') // returns 'zhipu'
 * detectProvider('https://unknown.com/api') // returns 'unknown'
 */
export function detectProvider(baseUrl: string): ApiProvider {
  // Wrapper around shared detectProvider with verbose logging for main process
  const isVerbose = process.env.VERBOSE === 'true';

  const provider = sharedDetectProvider(baseUrl);

  if (isVerbose) {
    console.warn('[UsageMonitor:PROVIDER_DETECTION] Detected provider:', {
      baseUrl,
      provider
    });
  }

  return provider;
}

/**
 * Result of determining the active profile type
 */
interface ActiveProfileResult {
  profileId: string;
  profileName: string;
  profileEmail?: string;
  isAPIProfile: boolean;
  baseUrl: string;
  credential?: string;
}

/** An amount of money as the usage API sends it: minor units and their exponent */
function moneyAmount(value: any): number | undefined {
  if (!value || typeof value.amount_minor !== 'number') return undefined;
  const exponent = typeof value.exponent === 'number' ? value.exponent : 2;
  return value.amount_minor / 10 ** exponent;
}

/**
 * An account summary's spend limit: the one just fetched, else (the fetch failed, the stored
 * percents stand in) the one it had (its last summary, else the usage saved with it), so an
 * Enterprise account keeps showing its monthly limit
 */
function spendLimitOf(fetched: ClaudeUsageSnapshot | null, previous: { spendLimit?: UsageSpendLimit } | undefined): { spendLimit?: UsageSpendLimit } {
  const spendLimit = fetched ? fetched.spendLimit : previous?.spendLimit;
  return spendLimit ? { spendLimit } : {};
}

/**
 * The monthly spend limit the usage API reports (`spend`, else the older `extra_usage`), when it
 * is on. Enterprise accounts have it instead of the 5-hour and weekly windows
 */
function readSpendLimit(data: any): UsageSpendLimit | undefined {
  const spend = data?.spend;
  if (spend && spend.enabled !== false) {
    const used = moneyAmount(spend.used);
    if (used !== undefined) {
      return {
        used,
        limit: moneyAmount(spend.limit) ?? null,
        currency: spend.used.currency || spend.limit?.currency || 'USD',
      };
    }
  }
  const extra = data?.extra_usage;
  if (extra?.is_enabled && typeof extra.used_credits === 'number') {
    const scale = 10 ** (typeof extra.decimal_places === 'number' ? extra.decimal_places : 2);
    return {
      used: extra.used_credits / scale,
      limit: typeof extra.monthly_limit === 'number' ? extra.monthly_limit / scale : null,
      currency: extra.currency || 'USD',
    };
  }
  return undefined;
}

/**
 * Type guard to check if an error has an HTTP status code
 * @param error - The error to check
 * @returns true if the error has a statusCode property
 */
function isHttpError(error: unknown): error is Error & { statusCode?: number } {
  return error instanceof Error && 'statusCode' in error;
}

export class UsageMonitor extends EventEmitter {
  private static instance: UsageMonitor;
  private intervalId: NodeJS.Timeout | null = null;
  private currentUsage: ClaudeUsageSnapshot | null = null;
  private currentUsageProfileId: string | null = null; // Track which profile's usage is in currentUsage
  private isChecking = false;
  // A usage refresh asked for while a check was running (an account switch); runs when it ends
  private recheckPending = false;
  // Bumped on every account switch, so a check that started before it doesn't store the old
  // account's usage as the new one's
  private activeProfileGeneration = 0;
  private unsubscribeActiveProfile: (() => void) | null = null;

  // Per-profile API failure tracking with cooldown-based retry
  // Map<profileId, lastFailureTimestamp> - stores when API last failed for this profile
  private apiFailureTimestamps: Map<string, number> = new Map();
  private static API_FAILURE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes cooldown before API retry

  // Track profiles that need re-authentication (invalid refresh token)
  // These profiles have permanent auth failures that require manual re-auth
  private needsReauthProfiles: Set<string> = new Set();

  // Cache for all profiles' usage data
  // Map<profileId, { usage: ProfileUsageSummary, fetchedAt: number }>
  private allProfilesUsageCache: Map<string, { usage: ProfileUsageSummary; fetchedAt: number }> = new Map();
  private static PROFILE_USAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache for inactive profiles
  private static USAGE_CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds for active profile polling

  // Request coalescing: track in-flight getAllProfilesUsage() promise to avoid parallel duplicate fetches
  private allProfilesUsageInflight: Promise<AllProfilesUsage | null> | null = null;

  // Rate-limit (429) tracking: separate from general API failures, uses longer cooldown
  private rateLimitedProfiles: Map<string, number> = new Map(); // profileId -> 429 timestamp
  private static RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes cooldown for 429s

  // Debug flag for verbose logging
  private readonly isDebug = process.env.DEBUG === 'true';
  // Verbose flag for trace-level logging (only with VERBOSE=true)
  private readonly isVerbose = process.env.VERBOSE === 'true';

  /**
   * Debug log helper - only logs when DEBUG=true
   */
  private debugLog(message: string, data?: unknown): void {
    if (this.isDebug) {
      if (data !== undefined) {
        console.warn(message, data);
      } else {
        console.warn(message);
      }
    }
  }

  /**
   * Trace log helper - only logs when VERBOSE=true (more granular than debug)
   */
  private traceLog(message: string, data?: unknown): void {
    if (this.isVerbose) {
      if (data !== undefined) {
        console.warn(message, data);
      } else {
        console.warn(message);
      }
    }
  }

  private constructor() {
    super();
    this.debugLog('[UsageMonitor] Initialized');
  }

  static getInstance(): UsageMonitor {
    if (!UsageMonitor.instance) {
      UsageMonitor.instance = new UsageMonitor();
    }
    return UsageMonitor.instance;
  }

  /**
   * Start monitoring usage at configured interval
   *
   * Note: Usage monitoring always runs to display the usage badge.
   *
   * Update interval: 60 seconds (60000ms) for active profile; inactive profiles every 5 minutes (adaptive: 60s when usage is high)
   */
  start(): void {
    if (this.intervalId) {
      this.debugLog('[UsageMonitor] Already running');
      return;
    }

    const profileManager = getClaudeProfileManager();
    const interval = UsageMonitor.USAGE_CHECK_INTERVAL_MS;

    this.debugLog('[UsageMonitor] Starting with interval: ' + interval + ' ms (60-second updates for active profile usage stats)');

    // Every way of switching accounts (Settings, terminals) goes through the profile manager
    this.unsubscribeActiveProfile = profileManager.onActiveProfileChanged?.((profileId) => {
      this.handleActiveProfileChanged(profileId);
    }) ?? null;

    // Check immediately
    this.checkUsage();

    // Then check periodically
    this.intervalId = setInterval(() => {
      this.checkUsage();
    }, interval);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.debugLog('[UsageMonitor] Stopped');
    }
    this.unsubscribeActiveProfile?.();
    this.unsubscribeActiveProfile = null;
  }

  /**
   * The account in use changed: show the new account's stored usage right away (or nothing, so
   * the badge waits for it, when it was never fetched) instead of the previous account's, then
   * fetch its usage in the background.
   */
  handleActiveProfileChanged(profileId: string): void {
    this.activeProfileGeneration++;
    if (this.currentUsageProfileId !== profileId) {
      const stored = this.getStoredUsageSnapshot(profileId);
      this.currentUsage = stored;
      this.currentUsageProfileId = stored ? profileId : null;
      this.emit('usage-updated', stored);
    }

    // The accounts list as cached, with the account in use marked
    const cached = this.buildCachedAllProfilesUsage();
    if (cached) this.emit('all-profiles-usage-updated', cached);

    this.refreshUsage();
  }

  /** Fetch the active account's usage now (queued behind a running check) */
  private refreshUsage(): void {
    if (this.isChecking) {
      this.recheckPending = true;
      return;
    }
    this.checkUsage().catch(error => {
      appLog.error('[UsageMonitor] Usage refresh failed:', error);
    });
  }

  /** The last usage known for a profile: its cached summary, else the usage saved with it */
  private getStoredUsageSnapshot(profileId: string): ClaudeUsageSnapshot | null {
    const profile = getClaudeProfileManager().getProfile(profileId);
    if (!profile || !usesClaudeSubscription(profile)) return null;
    const cached = this.allProfilesUsageCache.get(profileId)?.usage;
    if (cached?.lastFetchedAt) {
      return {
        profileId,
        profileName: profile.name,
        profileEmail: profile.email ?? cached.profileEmail,
        sessionPercent: cached.sessionPercent,
        weeklyPercent: cached.weeklyPercent,
        sessionResetTimestamp: cached.sessionResetTimestamp,
        weeklyResetTimestamp: cached.weeklyResetTimestamp,
        spendLimit: cached.spendLimit,
        fetchedAt: new Date(cached.lastFetchedAt),
        needsReauthentication: this.needsReauthProfiles.has(profileId)
      };
    }
    if (profile.usage?.lastUpdated) {
      return {
        profileId,
        profileName: profile.name,
        profileEmail: profile.email,
        sessionPercent: profile.usage.sessionUsagePercent ?? 0,
        weeklyPercent: profile.usage.weeklyUsagePercent ?? 0,
        ...(profile.usage.spendLimit ? { spendLimit: profile.usage.spendLimit } : {}),
        fetchedAt: profile.usage.lastUpdated,
        needsReauthentication: this.needsReauthProfiles.has(profileId)
      };
    }
    return null;
  }

  /** The cached accounts list with `isActive` following the account in use (null before any fetch) */
  private buildCachedAllProfilesUsage(): AllProfilesUsage | null {
    if (this.allProfilesUsageCache.size === 0) return null;
    const settings = getClaudeProfileManager().getSettings();
    const allProfiles = settings.profiles
      .map((profile) => this.allProfilesUsageCache.get(profile.id)?.usage)
      .filter((summary): summary is ProfileUsageSummary => !!summary)
      .map((summary) => ({ ...summary, isActive: summary.profileId === settings.activeProfileId }))
      .sort((a, b) => b.availabilityScore - a.availabilityScore);
    return {
      activeProfile: this.currentUsage ?? this.emptySnapshot(settings.activeProfileId),
      allProfiles,
      fetchedAt: new Date()
    };
  }

  /** A placeholder snapshot for an account whose usage isn't known yet */
  private emptySnapshot(profileId: string | undefined): ClaudeUsageSnapshot {
    const settings = getClaudeProfileManager().getSettings();
    return {
      profileId: profileId || '',
      profileName: settings.profiles.find(p => p.id === profileId)?.name || '',
      sessionPercent: 0,
      weeklyPercent: 0,
      fetchedAt: new Date(),
      needsReauthentication: this.needsReauthProfiles.has(profileId || '')
    };
  }

  /**
   * Get current usage snapshot (for UI indicator)
   */
  getCurrentUsage(): ClaudeUsageSnapshot | null {
    return this.currentUsage;
  }

  /**
   * Clear the usage cache for a specific profile.
   * Called after re-authentication to ensure fresh usage data is fetched.
   *
   * @param profileId - Profile identifier to clear cache for
   */
  clearProfileUsageCache(profileId: string): void {
    const deleted = this.allProfilesUsageCache.delete(profileId);

    // Also clear currentUsage if it belongs to this profile
    // This prevents stale data from being displayed when getAllProfilesUsage()
    // uses this.currentUsage for the active profile
    const clearedCurrentUsage = this.currentUsageProfileId === profileId;
    if (clearedCurrentUsage) {
      this.currentUsage = null;
      this.currentUsageProfileId = null;
    }

    this.debugLog('[UsageMonitor] Cleared usage cache for profile:', {
      profileId,
      wasInCache: deleted,
      clearedCurrentUsage
    });
  }

  /**
   * Trigger an immediate usage check.
   * Called after re-authentication to give the user immediate feedback.
   */
  checkNow(): void {
    this.debugLog('[UsageMonitor] Immediate check triggered');
    this.checkUsage().catch(error => {
      console.error('[UsageMonitor] Immediate check failed:', error);
    });
  }

  /**
   * Get all profiles usage data (for multi-profile display in UI)
   * Returns cached data if fresh, otherwise fetches for all profiles
   *
   * Uses parallel fetching for inactive profiles to minimize blocking delays.
   *
   * @param forceRefresh - If true, bypasses cache and fetches fresh data for all profiles
   */
  async getAllProfilesUsage(forceRefresh: boolean = false): Promise<AllProfilesUsage | null> {
    const profileManager = getClaudeProfileManager();
    const settings = profileManager.getSettings();
    const activeProfileId = settings.activeProfileId;

    // CRITICAL: On startup, currentUsage may be null, but we still need to check for
    // missing credentials to show the re-auth indicator. Proactively check all profiles
    // for missing credentials and populate needsReauthProfiles.
    if (!this.currentUsage && this.allProfilesUsageCache.size === 0) {
      // Fast path: no coalescing needed since this is synchronous-ish and returns quickly
      // Check all OAuth profiles for missing credentials
      for (const profile of settings.profiles) {
        if (profile.configDir && usesClaudeSubscription(profile)) {
          const expandedConfigDir = expandClaudeHome(profile.configDir);
          const creds = getCredentialsFromKeychain(expandedConfigDir);
          if (!creds.token) {
            // Credentials are missing - mark for re-auth
            this.needsReauthProfiles.add(profile.id);
            this.debugLog('[UsageMonitor:getAllProfilesUsage] Profile needs re-auth (no credentials): ' + profile.name);
          }
        }
      }

      // Build a minimal response with needsReauthentication flags even without usage data: the
      // usage saved with each profile, or none (no lastFetchedAt, so it reads as not fetched)
      const allProfiles: ProfileUsageSummary[] = settings.profiles.map(profile => ({
        profileId: profile.id,
        profileName: profile.name,
        profileEmail: profile.email,
        sessionPercent: profile.usage?.sessionUsagePercent ?? 0,
        weeklyPercent: profile.usage?.weeklyUsagePercent ?? 0,
        ...(profile.usage?.spendLimit ? { spendLimit: profile.usage.spendLimit } : {}),
        isAuthenticated: profile.isAuthenticated ?? false,
        isRateLimited: false,
        availabilityScore: profile.isAuthenticated ? 100 : 0,
        isActive: profile.id === activeProfileId,
        lastFetchedAt: profile.usage?.lastUpdated?.toISOString(),
        needsReauthentication: this.needsReauthProfiles.has(profile.id)
      }));

      // Return minimal data with auth status - don't return null!
      return {
        activeProfile: this.emptySnapshot(activeProfileId),
        allProfiles,
        fetchedAt: new Date()
      };
    }

    // Request coalescing: if a fetch is already in-flight, return the existing promise
    // This prevents burst API calls when multiple callers trigger getAllProfilesUsage() simultaneously
    if (!forceRefresh && this.allProfilesUsageInflight) {
      return this.allProfilesUsageInflight;
    }

    this.allProfilesUsageInflight = this._doGetAllProfilesUsage(forceRefresh);
    try {
      return await this.allProfilesUsageInflight;
    } finally {
      this.allProfilesUsageInflight = null;
    }
  }

  private async _doGetAllProfilesUsage(
    forceRefresh: boolean
  ): Promise<AllProfilesUsage | null> {
    const profileManager = getClaudeProfileManager();
    const settings = profileManager.getSettings();
    const activeProfileId = settings.activeProfileId;
    const now = Date.now();
    const allProfiles: ProfileUsageSummary[] = [];

    // First pass: identify profiles that need fresh data vs cached
    type ProfileToFetch = { profile: typeof settings.profiles[0]; index: number };
    const profilesToFetch: ProfileToFetch[] = [];
    const profileResults: (ProfileUsageSummary | null)[] = new Array(settings.profiles.length).fill(null);

    const effectiveCacheTtl = UsageMonitor.PROFILE_USAGE_CACHE_TTL_MS;

    for (let i = 0; i < settings.profiles.length; i++) {
      const profile = settings.profiles[i];
      // No subscription usage for a detected cloud provider, API key or gateway setup
      if (!usesClaudeSubscription(profile)) continue;
      // For the active profile, use the current detailed usage (fresh from the last poll), but
      // only when it is this profile's: right after an account switch it still belongs to the
      // previous account until the new one's usage is fetched
      // (cached as of when it was fetched: right after a switch it is the stored, older snapshot)
      if (profile.id === activeProfileId && this.currentUsage && this.currentUsageProfileId === profile.id) {
        const summary = this.buildProfileUsageSummary(profile, this.currentUsage);
        profileResults[i] = summary;
        const fetchedAt = new Date(this.currentUsage.fetchedAt).getTime();
        this.allProfilesUsageCache.set(profile.id, { usage: summary, fetchedAt: Number.isFinite(fetchedAt) ? Math.min(fetchedAt, now) : now });
        continue;
      }

      const cached = this.allProfilesUsageCache.get(profile.id);

      // Use cached data if fresh (within TTL) and not force refreshing
      if (!forceRefresh && cached && (now - cached.fetchedAt) < effectiveCacheTtl) {
        profileResults[i] = {
          ...cached.usage,
          isActive: profile.id === activeProfileId
        };
        continue;
      }

      // Mark for parallel fetch
      profilesToFetch.push({ profile, index: i });
    }

    // Parallel fetch for all inactive profiles that need fresh data
    if (profilesToFetch.length > 0) {
      // Collect usage updates for batch save (avoids race condition with concurrent saves)
      const usageUpdates: Array<{ profileId: string; sessionPercent: number; weeklyPercent: number; spendLimit?: UsageSpendLimit }> = [];

      // DEDUPLICATION: Group profiles by configDir to avoid fetching the same underlying
      // account multiple times. Multiple ClaudeProfileManager entries can point to the same
      // configDir (same OAuth credentials = same API endpoint = same usage data).
      // Only fetch once per unique configDir, then share the result with all siblings.
      type FetchItem = { profile: typeof profilesToFetch[0]['profile']; index: number };
      const configDirGroups = new Map<string, FetchItem[]>(); // configDir -> all profiles sharing it
      const noConfigDirItems: FetchItem[] = []; // profiles without configDir (API key profiles)

      for (const item of profilesToFetch) {
        const configDir = item.profile.configDir;
        if (configDir) {
          const group = configDirGroups.get(configDir) ?? [];
          group.push(item);
          configDirGroups.set(configDir, group);
        } else {
          noConfigDirItems.push(item);
        }
      }

      // Build the deduplicated fetch list: one representative per configDir + all non-configDir items
      const deduplicatedFetchItems: FetchItem[] = [];
      const configDirRepresentatives = new Map<string, FetchItem>(); // configDir -> representative item
      for (const [configDir, group] of configDirGroups) {
        const representative = group[0]; // fetch for the first profile in the group
        deduplicatedFetchItems.push(representative);
        configDirRepresentatives.set(configDir, representative);
      }
      deduplicatedFetchItems.push(...noConfigDirItems);

      if (configDirGroups.size < profilesToFetch.length - noConfigDirItems.length) {
        this.debugLog('[UsageMonitor] Deduplicated profiles by configDir:', {
          original: profilesToFetch.length,
          deduplicated: deduplicatedFetchItems.length,
          savedFetches: profilesToFetch.length - deduplicatedFetchItems.length
        });
      }

      // All Claude profiles share one provider (Anthropic): fetch them as one staggered group
      const providerGroups = new Map<string, FetchItem[]>([['anthropic', deduplicatedFetchItems]]);

      // 15-second stagger between consecutive same-provider fetches
      const STAGGER_DELAY_MS = 15_000;

      // Fetch provider groups in parallel; within each group, stagger sequentially
      type FetchResult = {
        index: number;
        update: { profileId: string; sessionPercent: number; weeklyPercent: number; spendLimit?: UsageSpendLimit } | null;
        profile: FetchItem['profile'];
        inactiveUsage: ClaudeUsageSnapshot | null;
        rateLimitStatus: ReturnType<typeof isProfileRateLimited>;
        sessionPercent?: number;
        weeklyPercent?: number;
      };
      const groupPromises = Array.from(providerGroups.values()).map(async (group) => {
        const groupResults: FetchResult[] = [];

        for (let gi = 0; gi < group.length; gi++) {
          if (gi > 0) {
            await new Promise<void>(resolve => setTimeout(resolve, STAGGER_DELAY_MS));
          }
          const { profile, index } = group[gi];
          const inactiveUsage = await this.fetchUsageForInactiveProfile(profile);
          const rateLimitStatus = isProfileRateLimited(profile);

          if (inactiveUsage) {
            groupResults.push({
              index,
              update: {
                profileId: profile.id,
                sessionPercent: inactiveUsage.sessionPercent,
                weeklyPercent: inactiveUsage.weeklyPercent,
                ...(inactiveUsage.spendLimit ? { spendLimit: inactiveUsage.spendLimit } : {}),
              },
              profile,
              inactiveUsage,
              rateLimitStatus
            });
          } else {
            groupResults.push({
              index,
              update: null,
              profile,
              inactiveUsage,
              rateLimitStatus,
              sessionPercent: profile.usage?.sessionUsagePercent ?? 0,
              weeklyPercent: profile.usage?.weeklyUsagePercent ?? 0
            });
          }
        }
        return groupResults;
      });

      // Wait for all provider groups to complete in parallel
      const allGroupResults = await Promise.all(groupPromises);
      const fetchResults = allGroupResults.flat();

      // Build a map of configDir -> fetch result for sharing with sibling profiles
      const configDirFetchResults = new Map<string, FetchResult>();

      // Collect all updates and build summaries for fetched (representative) profiles
      for (const result of fetchResults) {
        const { index, update, profile, inactiveUsage, rateLimitStatus } = result;

        // Get percentages from either the update or the fallback values
        const sessionPercent = update?.sessionPercent ?? result.sessionPercent ?? 0;
        const weeklyPercent = update?.weeklyPercent ?? result.weeklyPercent ?? 0;

        if (update) {
          usageUpdates.push(update);
        }

        const summary: ProfileUsageSummary = {
          profileId: profile.id,
          profileName: profile.name,
          profileEmail: profile.email,
          sessionPercent,
          weeklyPercent,
          isAuthenticated: profile.isAuthenticated ?? false,
          isRateLimited: rateLimitStatus.limited,
          rateLimitType: rateLimitStatus.type,
          availabilityScore: this.calculateAvailabilityScore(
            sessionPercent,
            weeklyPercent,
            rateLimitStatus.limited,
            rateLimitStatus.type,
            profile.isAuthenticated ?? false
          ),
          isActive: profile.id === activeProfileId,
          lastFetchedAt: inactiveUsage?.fetchedAt?.toISOString() ?? profile.usage?.lastUpdated?.toISOString(),
          needsReauthentication: this.needsReauthProfiles.has(profile.id),
          ...spendLimitOf(inactiveUsage, this.allProfilesUsageCache.get(profile.id)?.usage ?? profile.usage)
        };

        this.allProfilesUsageCache.set(profile.id, { usage: summary, fetchedAt: now });
        profileResults[index] = summary;

        // Store fetch result for sibling profiles sharing the same configDir
        if (profile.configDir) {
          configDirFetchResults.set(profile.configDir, result);
        }
      }

      // Propagate fetch results to sibling profiles that share the same configDir
      // (these were deduplicated above and not fetched individually)
      for (const [configDir, group] of configDirGroups) {
        if (group.length <= 1) continue; // No siblings to propagate to
        const representativeResult = configDirFetchResults.get(configDir);
        if (!representativeResult) continue;

        const { inactiveUsage } = representativeResult;
        const sessionPercent = representativeResult.update?.sessionPercent ?? representativeResult.sessionPercent ?? 0;
        const weeklyPercent = representativeResult.update?.weeklyPercent ?? representativeResult.weeklyPercent ?? 0;

        // Skip the first item (already processed as the representative)
        for (let si = 1; si < group.length; si++) {
          const sibling = group[si];
          const rateLimitStatus = isProfileRateLimited(sibling.profile);

          // Copy rate-limit/failure state from representative to sibling
          if (this.rateLimitedProfiles.has(representativeResult.profile.id)) {
            const ts = this.rateLimitedProfiles.get(representativeResult.profile.id)!;
            this.rateLimitedProfiles.set(sibling.profile.id, ts);
          }

          usageUpdates.push({
            profileId: sibling.profile.id,
            sessionPercent,
            weeklyPercent,
            ...(representativeResult.update?.spendLimit ? { spendLimit: representativeResult.update.spendLimit } : {}),
          });

          const summary: ProfileUsageSummary = {
            profileId: sibling.profile.id,
            profileName: sibling.profile.name,
            profileEmail: sibling.profile.email,
            sessionPercent,
            weeklyPercent,
            isAuthenticated: sibling.profile.isAuthenticated ?? false,
            isRateLimited: rateLimitStatus.limited,
            rateLimitType: rateLimitStatus.type,
            availabilityScore: this.calculateAvailabilityScore(
              sessionPercent,
              weeklyPercent,
              rateLimitStatus.limited,
              rateLimitStatus.type,
              sibling.profile.isAuthenticated ?? false
            ),
            isActive: sibling.profile.id === activeProfileId,
            lastFetchedAt: inactiveUsage?.fetchedAt?.toISOString() ?? sibling.profile.usage?.lastUpdated?.toISOString(),
            needsReauthentication: this.needsReauthProfiles.has(sibling.profile.id),
            ...spendLimitOf(inactiveUsage, this.allProfilesUsageCache.get(sibling.profile.id)?.usage ?? sibling.profile.usage)
          };

          this.allProfilesUsageCache.set(sibling.profile.id, { usage: summary, fetchedAt: now });
          profileResults[sibling.index] = summary;
        }
      }

      // Batch save all usage updates at once (single disk write, no race condition)
      if (usageUpdates.length > 0) {
        profileManager.batchUpdateProfileUsageFromAPI(usageUpdates);
      }
    }

    // Collect non-null results
    for (const result of profileResults) {
      if (result) {
        allProfiles.push(result);
      }
    }

    // Sort by availability score (highest first = most available)
    allProfiles.sort((a, b) => b.availabilityScore - a.availabilityScore);

    return {
      activeProfile: this.currentUsage && this.currentUsageProfileId === activeProfileId
        ? this.currentUsage
        : this.emptySnapshot(activeProfileId),
      allProfiles,
      fetchedAt: new Date()
    };
  }

  /**
   * Fetch usage for an inactive profile using its own credentials
   * This allows showing real usage data for non-active profiles
   *
   * Uses ensureValidToken to proactively refresh tokens before making API calls,
   * preventing 401 errors for inactive profiles whose tokens may have expired.
   */
  private async fetchUsageForInactiveProfile(
    profile: { id: string; name: string; email?: string; configDir?: string; isAuthenticated?: boolean }
  ): Promise<ClaudeUsageSnapshot | null> {
    // Only fetch for authenticated profiles with a configDir
    if (!profile.isAuthenticated || !profile.configDir) {
      this.debugLog('[UsageMonitor] Skipping inactive profile fetch - not authenticated or no configDir:', {
        profileId: profile.id,
        profileName: profile.name,
        isAuthenticated: profile.isAuthenticated,
        hasConfigDir: !!profile.configDir
      });
      return null;
    }

    try {
      // Get credentials from keychain for this profile's configDir
      const expandedConfigDir = expandClaudeHome(profile.configDir);

      // Use ensureValidToken to proactively refresh the token if near expiry
      // This is critical for inactive profiles whose tokens may have expired
      let token: string | null = null;
      let wasRefreshed = false;

      try {
        const tokenResult = await ensureValidToken(expandedConfigDir);

        if (tokenResult.wasRefreshed) {
          this.debugLog('[UsageMonitor] Proactively refreshed token for inactive profile: ' + profile.name, {
            tokenFingerprint: getCredentialFingerprint(tokenResult.token)
          });
          wasRefreshed = true;

          // Check if token refresh succeeded but persistence failed
          // The token works for this session but will be lost on restart
          if (tokenResult.persistenceFailed) {
            console.warn('[UsageMonitor] Token refreshed but persistence failed for profile: ' + profile.name +
              ' - user should re-authenticate to avoid auth errors on next restart');
            this.needsReauthProfiles.add(profile.id);
          } else {
            // Token was refreshed and persisted successfully - clear from needsReauth if present
            this.needsReauthProfiles.delete(profile.id);
          }
        }

        token = tokenResult.token;

        // If we got a valid token (regardless of refresh), clear the needs-reauth flag.
        // This handles the case where the startup null-check in getAllProfilesUsage()
        // incorrectly marked the profile (sync keychain read returned null, but async
        // ensureValidToken succeeds later).
        if (token && !tokenResult.persistenceFailed) {
          this.needsReauthProfiles.delete(profile.id);
        }

        if (tokenResult.error) {
          this.debugLog('[UsageMonitor] Token validation failed for inactive profile: ' + profile.name, tokenResult.error);

          // Check for invalid_grant error - indicates refresh token is invalid
          // and user needs to manually re-authenticate
          if (tokenResult.errorCode === 'invalid_grant') {
            this.debugLog('[UsageMonitor] Profile needs re-authentication (invalid refresh token): ' + profile.name);
            this.needsReauthProfiles.add(profile.id);
          }

          // Check for missing_credentials error - indicates no token in credential store
          // User needs to authenticate via /login
          if (tokenResult.errorCode === 'missing_credentials') {
            this.debugLog('[UsageMonitor] Profile needs authentication (no credentials found): ' + profile.name);
            this.needsReauthProfiles.add(profile.id);
          }
        }
      } catch (error) {
        this.debugLog('[UsageMonitor] ensureValidToken failed for inactive profile: ' + profile.name, error);
      }

      // Fallback: Try direct keychain read if ensureValidToken failed
      if (!token) {
        const keychainCreds = getCredentialsFromKeychain(expandedConfigDir);
        token = keychainCreds.token;

        if (!token) {
          this.debugLog('[UsageMonitor] No keychain credentials for inactive profile: ' + profile.name);
          // Mark profile as needing re-authentication since credentials are missing
          this.needsReauthProfiles.add(profile.id);
          return null;
        }
        // Got a valid token from keychain fallback — clear stale needs-reauth flag
        this.needsReauthProfiles.delete(profile.id);
      }

      this.traceLog('[UsageMonitor] Fetching usage for inactive profile:', {
        profileId: profile.id,
        profileName: profile.name,
        tokenFingerprint: getCredentialFingerprint(token),
        wasRefreshed
      });

      // Fetch usage via API - OAuth profiles always use Anthropic
      const usage = await this.fetchUsageViaAPI(
        token,
        profile.id,
        profile.name,
        profile.email,
        {
          profileId: profile.id,
          profileName: profile.name,
          profileEmail: profile.email,
          isAPIProfile: false,
          baseUrl: 'https://api.anthropic.com'
        }
      );

      if (usage) {
        this.traceLog('[UsageMonitor] Successfully fetched inactive profile usage:', {
          profileName: profile.name,
          sessionPercent: usage.sessionPercent,
          weeklyPercent: usage.weeklyPercent
        });
      }

      return usage;
    } catch (error) {
      this.debugLog('[UsageMonitor] Failed to fetch inactive profile usage: ' + profile.name, error);
      return null;
    }
  }

  /**
   * Build a ProfileUsageSummary from a ClaudeUsageSnapshot
   */
  private buildProfileUsageSummary(
    profile: { id: string; name: string; email?: string; isAuthenticated?: boolean },
    usage: ClaudeUsageSnapshot
  ): ProfileUsageSummary {
    const profileManager = getClaudeProfileManager();
    const fullProfile = profileManager.getProfile(profile.id);
    const rateLimitStatus = fullProfile ? isProfileRateLimited(fullProfile) : { limited: false };

    return {
      profileId: profile.id,
      profileName: profile.name,
      profileEmail: profile.email || usage.profileEmail,
      sessionPercent: usage.sessionPercent,
      weeklyPercent: usage.weeklyPercent,
      sessionResetTimestamp: usage.sessionResetTimestamp,
      weeklyResetTimestamp: usage.weeklyResetTimestamp,
      isAuthenticated: profile.isAuthenticated ?? true,
      isRateLimited: rateLimitStatus.limited,
      rateLimitType: rateLimitStatus.type,
      availabilityScore: this.calculateAvailabilityScore(
        usage.sessionPercent,
        usage.weeklyPercent,
        rateLimitStatus.limited,
        rateLimitStatus.type,
        profile.isAuthenticated ?? true
      ),
      isActive: profile.id === profileManager.getActiveProfile()?.id,
      lastFetchedAt: usage.fetchedAt?.toISOString(),
      needsReauthentication: this.needsReauthProfiles.has(profile.id),
      ...(usage.spendLimit ? { spendLimit: usage.spendLimit } : {})
    };
  }

  /**
   * Calculate availability score for a profile (higher = more available)
   *
   * Scoring algorithm:
   * - Base score: 100
   * - Rate limited: -500 (session) or -1000 (weekly)
   * - Unauthenticated: -500
   * - Weekly usage penalty: -(weeklyPercent * 0.5)
   * - Session usage penalty: -(sessionPercent * 0.2)
   */
  private calculateAvailabilityScore(
    sessionPercent: number,
    weeklyPercent: number,
    isRateLimited: boolean,
    rateLimitType?: 'session' | 'weekly',
    isAuthenticated: boolean = true
  ): number {
    let score = 100;

    // Penalize rate-limited profiles heavily
    if (isRateLimited) {
      if (rateLimitType === 'weekly') {
        score -= 1000; // Weekly limit is worse (takes longer to reset)
      } else {
        score -= 500; // Session limit resets sooner
      }
    }

    // Penalize unauthenticated profiles
    if (!isAuthenticated) {
      score -= 500;
    }

    // Penalize based on current usage (weekly more important)
    score -= weeklyPercent * 0.5;
    score -= sessionPercent * 0.2;

    return Math.round(score * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Fetch the account in use's usage (and the accounts list) and emit it for the UI
   *
   * - determineActiveProfile(): Detects API vs OAuth profile
   * - handleAuthFailure(): Manages auth failure recovery (token refresh)
   */
  private async checkUsage(): Promise<void> {
    if (this.isChecking) {
      return; // Prevent concurrent checks
    }

    this.isChecking = true;
    let profileId: string | undefined;
    let isAPIProfile = false;
    const generation = this.activeProfileGeneration;

    try {
      // Step 1: Determine active profile (API vs OAuth)
      const activeProfile = await this.determineActiveProfile();
      if (!activeProfile) {
        return; // No active profile
      }

      profileId = activeProfile.profileId;
      isAPIProfile = activeProfile.isAPIProfile;

      // Step 2: Fetch current usage using the credential resolved by determineActiveProfile
      const usage = await this.fetchUsage(profileId, activeProfile.credential, activeProfile);
      if (!usage) {
        this.traceLog('[UsageMonitor] Failed to fetch usage (API may be rate-limited or credential unavailable)');
        return;
      }

      // The account was switched while this fetched: this usage is the previous account's
      if (generation !== this.activeProfileGeneration) {
        this.recheckPending = true;
        return;
      }

      // Add needsReauthentication flag to the snapshot for the active profile
      usage.needsReauthentication = this.needsReauthProfiles.has(profileId);

      this.currentUsage = usage;
      this.currentUsageProfileId = profileId; // Track which profile this usage belongs to

      // Step 2.5: Persist usage to profile for caching (so other profiles can display cached usage)
      const profileManager = getClaudeProfileManager();
      profileManager.updateProfileUsageFromAPI(profileId, usage.sessionPercent, usage.weeklyPercent, usage.spendLimit);

      // Step 3: Emit usage update for UI
      this.emit('usage-updated', usage);

      // Step 3.5: Emit all profiles usage for multi-profile display
      const allProfilesUsage = await this.getAllProfilesUsage();
      if (allProfilesUsage) {
        this.emit('all-profiles-usage-updated', allProfilesUsage);

        // Single summary line for debug output
        if (this.isDebug) {
          const summary = allProfilesUsage.allProfiles
            .map(p => `${p.profileName} ${p.sessionPercent}%/${p.weeklyPercent}%`)
            .join(' | ');
          console.warn(`[UsageMonitor] Usage: ${summary}`);
        }
      }
    } catch (error) {
      // Step 4: Handle auth failures
      if (isHttpError(error) && (error.statusCode === 401 || error.statusCode === 403)) {
        if (profileId) {
          await this.handleAuthFailure(profileId, isAPIProfile);
          return; // handleAuthFailure manages its own logging
        }
      }

      console.error('[UsageMonitor] Check failed:', error);
    } finally {
      this.isChecking = false;
      if (this.recheckPending) {
        this.recheckPending = false;
        this.refreshUsage();
      }
    }
  }

  /**
   * Check if API method should be used for a specific profile
   *
   * Uses cooldown-based retry: API is retried after API_FAILURE_COOLDOWN_MS
   *
   * @param profileId - Profile identifier
   * @returns true if API should be tried, false if CLI should be used
   */
  private shouldUseApiMethod(profileId: string): boolean {
    // Check rate-limit (429) cooldown first — longer backoff than general API failures
    // Also check sibling profiles that share the same configDir (same underlying API endpoint).
    // When Anthropic 429s one profile, all profiles sharing the same credential are also blocked.
    const profileIdsToCheck = this.getProfileIdFamily(profileId);

    for (const id of profileIdsToCheck) {
      const lastRateLimit = this.rateLimitedProfiles.get(id);
      if (lastRateLimit) {
        const elapsed = Date.now() - lastRateLimit;
        if (elapsed < UsageMonitor.RATE_LIMIT_COOLDOWN_MS) {
          return false; // Any sibling is rate-limited → block all
        }
        this.rateLimitedProfiles.delete(id); // Cooldown expired, clear the marker
      }
    }

    // Check general API failure cooldown
    const lastFailure = this.apiFailureTimestamps.get(profileId);
    if (!lastFailure) return true; // No previous failure, try API
    // Check if cooldown has expired (use >= to allow retry at exact boundary)
    const elapsed = Date.now() - lastFailure;
    return elapsed >= UsageMonitor.API_FAILURE_COOLDOWN_MS;
  }

  /**
   * Get all profile IDs that share the same configDir as the given profile.
   * This is used to propagate rate-limit state across duplicate profile entries
   * that point to the same underlying OAuth credential/API endpoint.
   */
  private getProfileIdFamily(profileId: string): string[] {
    try {
      const profileManager = getClaudeProfileManager();
      const settings = profileManager.getSettings();
      const targetProfile = settings.profiles.find(p => p.id === profileId);

      if (!targetProfile?.configDir) return [profileId];

      // Find all profiles with the same configDir
      const siblings = settings.profiles
        .filter(p => p.configDir === targetProfile.configDir)
        .map(p => p.id);

      return siblings.length > 0 ? siblings : [profileId];
    } catch {
      return [profileId];
    }
  }

  /**
   * Determine which profile is active:
   *   1. The active API profile (custom Anthropic-compatible endpoint), when one is set
   *   2. ClaudeProfileManager.getActiveProfile() (Claude subscription sign-in)
   *
   * @returns Active profile info (including resolved credential) or null
   */
  private async determineActiveProfile(): Promise<ActiveProfileResult | null> {
    // First, check if an API profile is active
    try {
      const profilesFile = await loadProfilesFile();
      if (profilesFile.activeProfileId) {
        const activeAPIProfile = profilesFile.profiles.find(
          (p) => p.id === profilesFile.activeProfileId
        );
        if (activeAPIProfile?.apiKey) {
          this.traceLog('[UsageMonitor:TRACE] Active auth type: API Profile', {
            profileId: activeAPIProfile.id,
            profileName: activeAPIProfile.name,
            baseUrl: activeAPIProfile.baseUrl
          });
          return {
            profileId: activeAPIProfile.id,
            profileName: activeAPIProfile.name,
            isAPIProfile: true,
            baseUrl: activeAPIProfile.baseUrl,
            credential: activeAPIProfile.apiKey
          };
        }
      }
    } catch (error) {
      this.traceLog('[UsageMonitor:TRACE] Failed to load API profiles:', error);
    }

    // Fall back to Claude OAuth profile
    const profileManager = getClaudeProfileManager();
    const activeOAuthProfile = profileManager.getActiveProfile();

    if (!activeOAuthProfile) {
      this.debugLog('[UsageMonitor] No active profile found');
      return null;
    }
    // A detected setup on a cloud provider, an API key or a gateway has no subscription usage
    if (!usesClaudeSubscription(activeOAuthProfile)) {
      return null;
    }

    let profileEmail = activeOAuthProfile.email;
    if (!profileEmail) {
      const keychainCreds = getCredentialsFromKeychain(activeOAuthProfile.configDir);
      profileEmail = keychainCreds.email ?? undefined;
    }

    // Get credential via ensureValidToken
    let credential: string | undefined;
    try {
      const tokenResult = await ensureValidToken(activeOAuthProfile.configDir);
      if (tokenResult.token) {
        credential = tokenResult.token;
        if (!tokenResult.persistenceFailed) this.needsReauthProfiles.delete(activeOAuthProfile.id);
      } else if (tokenResult.errorCode === 'invalid_grant' || tokenResult.errorCode === 'missing_credentials') {
        this.needsReauthProfiles.add(activeOAuthProfile.id);
      }
    } catch {
      const keychainCreds = getCredentialsFromKeychain(activeOAuthProfile.configDir);
      credential = keychainCreds.token ?? undefined;
    }

    this.traceLog('[UsageMonitor:TRACE] Active auth type: OAuth Profile', {
      profileId: activeOAuthProfile.id,
      profileName: activeOAuthProfile.name,
      profileEmail
    });

    return {
      profileId: activeOAuthProfile.id,
      profileName: activeOAuthProfile.name,
      profileEmail,
      isAPIProfile: false,
      baseUrl: 'https://api.anthropic.com',
      credential
    };
  }

  /**
   * Handle auth failure by attempting token refresh (the account stays in use; one whose
   * refresh token is invalid is marked as needing re-authentication).
   *
   * @param profileId - Profile that failed auth
   * @param isAPIProfile - Whether this is an API profile (token refresh only for OAuth)
   */
  private async handleAuthFailure(profileId: string, isAPIProfile: boolean): Promise<void> {
    const profileManager = getClaudeProfileManager();

    // For OAuth profiles, attempt token refresh before giving up
    if (!isAPIProfile) {
      const profile = profileManager.getProfile(profileId);
      if (profile?.configDir) {
        this.debugLog('[UsageMonitor] Auth failure - attempting token refresh for profile: ' + profileId);

        try {
          const refreshResult = await reactiveTokenRefresh(profile.configDir);

          if (refreshResult.wasRefreshed && refreshResult.token) {
            this.debugLog('[UsageMonitor] Token refresh successful for profile: ' + profileId, {
              tokenFingerprint: getCredentialFingerprint(refreshResult.token)
            });

            // Check if token refresh succeeded but persistence failed
            // The token works for this session but will be lost on restart
            if (refreshResult.persistenceFailed) {
              console.warn('[UsageMonitor] Token refreshed but persistence failed for profile: ' + profileId +
                ' - user should re-authenticate to avoid auth errors on next restart');
              this.needsReauthProfiles.add(profileId);
            } else {
              // Token was refreshed and persisted successfully - clear from needsReauth if present
              this.needsReauthProfiles.delete(profileId);
            }

            // Token was refreshed - don't mark as failed, let next poll use the new token
            return;
          }

          if (refreshResult.error) {
            this.debugLog('[UsageMonitor] Token refresh failed:', refreshResult.error);

            // Check for invalid_grant error - indicates refresh token is permanently invalid
            // and user needs to manually re-authenticate (matches inactive profile handling)
            if (refreshResult.errorCode === 'invalid_grant') {
              this.debugLog('[UsageMonitor] Profile needs re-authentication (invalid refresh token): ' + profileId);
              this.needsReauthProfiles.add(profileId);
            }
          }
        } catch (refreshError) {
          console.error('[UsageMonitor] Token refresh threw error:', refreshError);
        }

        // Refresh failed - clear cache so next attempt gets fresh credentials
        this.debugLog('[UsageMonitor] Auth failure - clearing keychain cache for profile: ' + profileId);
        clearKeychainCache(profile.configDir);
      }
    }
  }

  /**
   * Fetch usage - HYBRID APPROACH
   * Tries API first, falls back to CLI if API fails
   *
   * Enhanced to support multiple providers (Anthropic, z.ai, ZHIPU)
   * Detects provider from active profile's baseUrl and routes to appropriate endpoint
   *
   * @param profileId - Profile identifier
   * @param credential - OAuth token or API key
   * @param activeProfile - Optional active profile info to avoid race conditions
   */
  private async fetchUsage(
    profileId: string,
    credential?: string,
    activeProfile?: ActiveProfileResult
  ): Promise<ClaudeUsageSnapshot | null> {
    // Get profile name and email - prefer activeProfile since it's already determined
    let profileName: string | undefined;
    let profileEmail: string | undefined;

    // Use activeProfile data if available (already fetched and validated)
    // This fixes the bug where API profile names were incorrectly shown for OAuth profiles
    if (activeProfile?.profileName) {
      profileName = activeProfile.profileName;
      profileEmail = activeProfile.profileEmail;
      this.traceLog('[UsageMonitor:FETCH] Using activeProfile data:', {
        profileId,
        profileName,
        profileEmail,
        isAPIProfile: activeProfile.isAPIProfile
      });
    }

    // Only search API profiles if not already set from activeProfile
    if (!profileName) {
      try {
        const profilesFile = await loadProfilesFile();
        const apiProfile = profilesFile.profiles.find(p => p.id === profileId);
        if (apiProfile) {
          profileName = apiProfile.name;
          this.traceLog('[UsageMonitor:FETCH] Found API profile:', {
            profileId,
            profileName,
            baseUrl: apiProfile.baseUrl
          });
        }
      } catch (error) {
        // Failed to load API profiles, continue to OAuth check
        this.traceLog('[UsageMonitor:FETCH] Failed to load API profiles:', error);
      }
    }

    // If not found in API profiles, check OAuth profiles
    if (!profileName) {
      const profileManager = getClaudeProfileManager();
      const oauthProfile = profileManager.getProfile(profileId);
      if (oauthProfile) {
        profileName = oauthProfile.name;
        // Get email from OAuth profile if not already set
        if (!profileEmail) {
          profileEmail = oauthProfile.email;
        }
        this.traceLog('[UsageMonitor:FETCH] Found OAuth profile:', {
          profileId,
          profileName,
          profileEmail
        });
      }
    }

    // If still not found, return null
    if (!profileName) {
      this.traceLog('[UsageMonitor:FETCH] Profile not found in either API or OAuth profiles: ' + profileId);
      return null;
    }

    this.traceLog('[UsageMonitor:FETCH] Starting usage fetch:', {
      profileId,
      profileName,
      hasCredential: !!credential,
      useApiMethod: this.shouldUseApiMethod(profileId)
    });

    // Attempt 1: Direct API call (preferred)
    // Per-profile tracking: if API fails for one profile, it only affects that profile
    if (this.shouldUseApiMethod(profileId) && credential) {
      this.traceLog('[UsageMonitor:FETCH] Attempting API fetch method');
      const apiUsage = await this.fetchUsageViaAPI(credential, profileId, profileName, profileEmail, activeProfile);
      if (apiUsage) {
        this.traceLog('[UsageMonitor] Successfully fetched via API');
        this.traceLog('[UsageMonitor:FETCH] API fetch successful:', {
          sessionPercent: apiUsage.sessionPercent,
          weeklyPercent: apiUsage.weeklyPercent
        });
        return apiUsage;
      }

      // API failed - record timestamp for cooldown-based retry
      this.traceLog('[UsageMonitor:FETCH] API fetch failed, will retry after cooldown');
      this.apiFailureTimestamps.set(profileId, Date.now());
    } else if (!credential) {
      this.traceLog('[UsageMonitor:FETCH] No credential available, skipping API method');
    }

    // Attempt 2: CLI /usage command (fallback)
    this.traceLog('[UsageMonitor:FETCH] Attempting CLI fallback method');
    return await this.fetchUsageViaCLI(profileId, profileName);
  }

  /**
   * Fetch usage via provider-specific API endpoints
   *
   * Supports multiple providers with automatic detection:
   * - Anthropic OAuth: https://api.anthropic.com/api/oauth/usage
   * - z.ai: https://api.z.ai/api/monitor/usage/model-usage
   * - ZHIPU: https://open.bigmodel.cn/api/monitor/usage/model-usage
   *
   * Detects provider from active profile's baseUrl and routes to appropriate endpoint.
   * Normalizes all provider responses to common ClaudeUsageSnapshot format.
   *
   * @param credential - OAuth token or API key
   * @param profileId - Profile identifier
   * @param profileName - Profile display name
   * @param profileEmail - Optional email associated with the profile
   * @param activeProfile - Optional pre-determined active profile info to avoid race conditions
   * @returns Normalized usage snapshot or null on failure
   */
  private async fetchUsageViaAPI(
    credential: string,
    profileId: string,
    profileName: string,
    profileEmail?: string,
    activeProfile?: ActiveProfileResult
  ): Promise<ClaudeUsageSnapshot | null> {
    this.traceLog('[UsageMonitor:API_FETCH] Starting API fetch for usage:', {
      profileId,
      profileName,
      hasCredential: !!credential,
      hasActiveProfile: !!activeProfile
    });

    try {
      // Step 1: Determine if we're using an API profile or OAuth profile
      // Use passed activeProfile if available, otherwise detect to maintain backward compatibility
      let apiProfile: APIProfile | undefined;
      let baseUrl: string;
      let provider: ApiProvider;

      if (activeProfile?.isAPIProfile) {
        // Use the pre-determined profile to avoid race conditions
        // Trust the activeProfile data and use baseUrl directly
        baseUrl = activeProfile.baseUrl;
        provider = detectProvider(baseUrl);
      } else if (activeProfile && !activeProfile.isAPIProfile) {
        // OAuth profile — detect provider from baseUrl
        baseUrl = activeProfile.baseUrl;
        provider = detectProvider(baseUrl);
      } else {
        // No activeProfile passed - need to detect from profiles file
        const profilesFile = await loadProfilesFile();
        apiProfile = profilesFile.profiles.find(p => p.id === profileId);

        if (apiProfile?.apiKey) {
          // API profile found
          baseUrl = apiProfile.baseUrl;
          provider = detectProvider(baseUrl);
        } else {
          // OAuth profile fallback
          provider = 'anthropic';
          baseUrl = 'https://api.anthropic.com';
        }
      }

      const isAPIProfile = !!apiProfile;
      this.traceLog('[UsageMonitor:TRACE] Fetching usage', {
        provider,
        baseUrl,
        isAPIProfile,
        profileId
      });

      // Step 3: Get provider-specific usage endpoint
      const usageEndpoint = getUsageEndpoint(provider, baseUrl);
      if (!usageEndpoint) {
        this.debugLog('[UsageMonitor] Unknown provider - no usage endpoint configured:', {
          provider,
          baseUrl,
          profileId
        });
        return null;
      }

      this.traceLog('[UsageMonitor:API_FETCH] API request:', {
        endpoint: usageEndpoint,
        profileId,
        credentialFingerprint: getCredentialFingerprint(credential)
      });

      this.traceLog('[UsageMonitor:API_FETCH] Fetching from endpoint:', {
        provider,
        endpoint: usageEndpoint,
        hasCredential: !!credential
      });

      // Step 4: Validate endpoint domain before making request
      // Security: Only allow requests to known provider domains
      let endpointHostname: string;
      try {
        const endpointUrl = new URL(usageEndpoint);
        endpointHostname = endpointUrl.hostname;
      } catch {
        console.error('[UsageMonitor] Invalid usage endpoint URL:', usageEndpoint);
        return null;
      }

      if (!ALLOWED_USAGE_API_DOMAINS.has(endpointHostname)) {
        console.error('[UsageMonitor] Blocked request to unauthorized domain:', endpointHostname, {
          allowedDomains: Array.from(ALLOWED_USAGE_API_DOMAINS)
        });
        return null;
      }

      // Step 5: Fetch usage from provider endpoint
      // All providers use Bearer token authentication (RFC 6750)
      // CodeQL: file data in outbound request - validate credential is a non-empty string before use
      const safeCredential = typeof credential === 'string' && credential.length > 0 ? credential : '';
      const authHeader = `Bearer ${safeCredential}`;

      // Build headers based on provider
      // Anthropic OAuth requires the 'anthropic-beta: oauth-2025-04-20' header
      // See: https://codelynx.dev/posts/claude-code-usage-limits-statusline
      const headers: Record<string, string> = {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      };

      if (provider === 'anthropic') {
        // OAuth authentication requires the beta header
        headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
        headers['anthropic-version'] = '2023-06-01';
      }

      const response = await fetch(usageEndpoint, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        console.error('[UsageMonitor] API error:', response.status, response.statusText, {
          provider,
          endpoint: usageEndpoint
        });

        // Handle rate limiting with a much longer backoff than general API failures
        // Propagate to all sibling profiles sharing the same configDir (same API endpoint)
        if (response.status === 429) {
          const now = Date.now();
          const siblingIds = this.getProfileIdFamily(profileId);
          console.warn('[UsageMonitor] Rate limited (429) by provider, backing off for 10 minutes:', {
            provider,
            endpoint: usageEndpoint,
            cooldownMs: UsageMonitor.RATE_LIMIT_COOLDOWN_MS,
            affectedProfiles: siblingIds.length
          });
          for (const id of siblingIds) {
            this.rateLimitedProfiles.set(id, now);
          }
          return null;
        }

        // Check for auth failures via status code (works for all providers)
        if (response.status === 401 || response.status === 403) {
          const error = new Error(`API Auth Failure: ${response.status} (${provider})`);
          (error as any).statusCode = response.status;
          throw error;
        }

        // For other error statuses, try to parse response body to detect auth failures
        // This handles cases where providers might return different status codes for auth errors
        let errorData: any;
        try {
          errorData = await response.json();
        } catch (parseError) {
          // If we can't parse the error response, just log it and continue
          this.traceLog('[UsageMonitor:AUTH_DETECTION] Could not parse error response body:', {
            provider,
            status: response.status,
            parseError
          });
          // Record failure timestamp for cooldown retry
          this.apiFailureTimestamps.set(profileId, Date.now());
          return null;
        }

        this.traceLog('[UsageMonitor:AUTH_DETECTION] Checking error response for auth failure:', {
          provider,
          status: response.status,
          errorData
        });

        // Check for common auth error patterns in response body
        const authErrorPatterns = [
          'unauthorized',
          'authentication',
          'invalid token',
          'invalid api key',
          'expired token',
          'forbidden',
          'access denied',
          'credentials',
          'auth failed'
        ];

        const errorText = JSON.stringify(errorData).toLowerCase();
        const hasAuthError = authErrorPatterns.some(pattern => errorText.includes(pattern));

        if (hasAuthError) {
          const error = new Error(`API Auth Failure detected in response body (${provider}): ${JSON.stringify(errorData)}`);
          (error as any).statusCode = response.status; // Include original status code
          (error as any).detectedInBody = true;
          throw error;
        }

        // Record failure timestamp for cooldown retry (non-auth error)
        this.apiFailureTimestamps.set(profileId, Date.now());
        return null;
      }

      this.traceLog('[UsageMonitor:API_FETCH] API response received successfully:', {
        provider,
        status: response.status,
        contentType: response.headers.get('content-type')
      });

      // Step 5: Parse and normalize response based on provider
      const rawData = await response.json();

      this.traceLog('[UsageMonitor:PROVIDER] Raw response from ' + provider + ':', JSON.stringify(rawData, null, 2));

      // Step 6: Extract data wrapper for z.ai and ZHIPU responses
      // These providers wrap the actual usage data in a 'data' field
      let responseData = rawData;
      if (provider === 'zai' || provider === 'zhipu') {
        if (rawData.data) {
          responseData = rawData.data;
          this.traceLog('[UsageMonitor:PROVIDER] Extracted data field from response:', {
            provider,
            extractedData: JSON.stringify(responseData, null, 2)
          });
        } else {
          this.traceLog('[UsageMonitor:PROVIDER] No data field found in response, using raw response:', {
            provider,
            responseKeys: Object.keys(rawData)
          });
        }
      }

      // Step 7: Normalize response based on provider type
      let normalizedUsage: ClaudeUsageSnapshot | null = null;

      this.traceLog('[UsageMonitor:NORMALIZATION] Selecting normalization method:', {
        provider,
        method: `normalize${provider.charAt(0).toUpperCase() + provider.slice(1)}Response`
      });

      switch (provider) {
        case 'anthropic':
          normalizedUsage = this.normalizeAnthropicResponse(rawData, profileId, profileName, profileEmail);
          break;
        case 'zai':
          normalizedUsage = this.normalizeZAIResponse(responseData, profileId, profileName, profileEmail);
          break;
        case 'zhipu':
          normalizedUsage = this.normalizeZhipuResponse(responseData, profileId, profileName, profileEmail);
          break;
        default:
          this.traceLog('[UsageMonitor:TRACE] Unsupported provider for usage normalization: ' + provider);
          return null;
      }

      if (!normalizedUsage) {
        this.traceLog('[UsageMonitor:TRACE] Failed to normalize response from ' + provider);
        // Record failure timestamp for cooldown retry (normalization failure)
        this.apiFailureTimestamps.set(profileId, Date.now());
        return null;
      }

      this.traceLog('[UsageMonitor:API_FETCH] Fetch completed - usage:', {
        profileId,
        profileName,
        email: normalizedUsage.profileEmail,
        provider,
        sessionPercent: normalizedUsage.sessionPercent,
        weeklyPercent: normalizedUsage.weeklyPercent,
        limitType: normalizedUsage.limitType
      });
      this.traceLog('[UsageMonitor:API_FETCH] API fetch completed successfully');

      return normalizedUsage;
    } catch (error: any) {
      // Re-throw auth failures to be handled by checkUsage
      // This includes both status code auth failures (401/403) and body-detected failures
      if (error?.message?.includes('Auth Failure') || error?.statusCode === 401 || error?.statusCode === 403) {
        throw error;
      }

      console.error('[UsageMonitor] API fetch failed:', error);
      // Record failure timestamp for cooldown retry (network/other errors)
      this.apiFailureTimestamps.set(profileId, Date.now());
      return null;
    }
  }

  /**
   * Normalize Anthropic API response to ClaudeUsageSnapshot
   *
   * Actual Anthropic OAuth usage API response format:
   * {
   *   "five_hour": {
   *     "utilization": 19,  // integer 0-100
   *     "resets_at": "2025-01-17T15:00:00Z"
   *   },
   *   "seven_day": {
   *     "utilization": 45,  // integer 0-100
   *     "resets_at": "2025-01-20T12:00:00Z"
   *   },
   *   "seven_day_opus": {    // premium-model weekly limit; newer responses may name it "seven_day_fable"
   *     "utilization": 0,    // integer 0-100
   *     "resets_at": "2025-01-20T12:00:00Z"
   *   }
   * }
   *
   * The premium-model bucket may be absent entirely - that means "no data", not 0,
   * so fablePercent/fableResetTimestamp stay undefined in that case.
   */
  private normalizeAnthropicResponse(
    data: any,
    profileId: string,
    profileName: string,
    profileEmail?: string
  ): ClaudeUsageSnapshot {
    // Support both new nested format and legacy flat format for backward compatibility
    //
    // NEW format (current API): { five_hour: { utilization: 72, resets_at: "..." } }
    // OLD format (legacy):      { five_hour_utilization: 0.72, five_hour_reset_at: "..." }

    let fiveHourUtil: number;
    let sevenDayUtil: number;
    let sessionResetTimestamp: string | undefined;
    let weeklyResetTimestamp: string | undefined;
    // Weekly limit scoped to one model (today: Fable) - stays undefined when the API omits it
    let fablePercent: number | undefined;
    let fableResetTimestamp: string | undefined;
    let fableModelName: string | undefined;

    // Enterprise accounts have no 5-hour or weekly window, only a monthly spend limit: both
    // percents are the share of it spent, so ranking and the tray follow the one limit there is.
    // Told by the current format's windows sent as null with no window limit listed (the legacy
    // flat format has no such keys; an account with windows lists them in `limits`)
    const windowLimits = Array.isArray(data.limits) && data.limits.some((limit: any) => limit?.kind === 'session' || limit?.kind === 'weekly_all');
    const noWindows = data.five_hour === null && data.seven_day === null && !windowLimits;
    const spendLimit = noWindows ? readSpendLimit(data) : undefined;
    if (spendLimit) {
      const percent = spendLimit.limit ? Math.min(100, (spendLimit.used / spendLimit.limit) * 100) : 0;
      return {
        sessionPercent: percent,
        weeklyPercent: percent,
        profileId,
        profileName,
        profileEmail,
        fetchedAt: new Date(),
        limitType: 'weekly',
        spendLimit,
      };
    }

    // Check for new nested format first
    if (data.five_hour !== undefined || data.seven_day !== undefined) {
      // New nested format - utilization is already 0-100 integer
      fiveHourUtil = data.five_hour?.utilization ?? 0;
      sevenDayUtil = data.seven_day?.utilization ?? 0;
      sessionResetTimestamp = data.five_hour?.resets_at;
      weeklyResetTimestamp = data.seven_day?.resets_at;

      // The model-scoped weekly limit is the "weekly_scoped" entry of the limits array, which
      // names the model itself ("Fable"); the per-model top-level buckets next to seven_day
      // (seven_day_opus and friends) are all null nowadays, so they are only a fallback.
      const scoped = Array.isArray(data.limits)
        ? data.limits.find((limit: any) => limit?.kind === 'weekly_scoped')
        : undefined;
      if (scoped) {
        fablePercent = scoped.percent;
        fableResetTimestamp = scoped.resets_at;
        fableModelName = scoped.scope?.model?.display_name;
      } else {
        const bucket = data.seven_day_opus ?? data.seven_day_fable;
        if (bucket) {
          fablePercent = bucket.utilization;
          fableResetTimestamp = bucket.resets_at;
        }
      }
    } else {
      // Legacy flat format - utilization is 0-1 float, needs *100
      const rawFiveHour = data.five_hour_utilization ?? 0;
      const rawSevenDay = data.seven_day_utilization ?? 0;
      // Convert 0-1 float to 0-100 integer
      fiveHourUtil = Math.round(rawFiveHour * 100);
      sevenDayUtil = Math.round(rawSevenDay * 100);
      sessionResetTimestamp = data.five_hour_reset_at;
      weeklyResetTimestamp = data.seven_day_reset_at;
      // Premium-model weekly bucket (flat keys, 0-1 float) - a missing value must stay undefined, not 0
      const rawFable = data.seven_day_opus_utilization ?? data.seven_day_fable_utilization;
      if (rawFable !== undefined && rawFable !== null) {
        fablePercent = Math.round(rawFable * 100);
      }
      fableResetTimestamp = data.seven_day_opus_reset_at ?? data.seven_day_fable_reset_at;
    }

    return {
      sessionPercent: fiveHourUtil,
      weeklyPercent: sevenDayUtil,
      // Omit sessionResetTime/weeklyResetTime - renderer uses timestamps with formatTimeRemaining
      sessionResetTime: undefined,
      weeklyResetTime: undefined,
      sessionResetTimestamp,
      weeklyResetTimestamp,
      fablePercent,
      fableResetTimestamp,
      fableModelName,
      profileId,
      profileName,
      profileEmail,
      fetchedAt: new Date(),
      // limitType only ranks session vs weekly - the Fable bucket is informational
      limitType: sevenDayUtil > fiveHourUtil ? 'weekly' : 'session',
      usageWindows: {
        sessionWindowLabel: 'common:usage.window5Hour',
        weeklyWindowLabel: 'common:usage.window7Day'
      }
    };
  }

  /**
   * Normalize quota/limit response for z.ai and ZHIPU providers
   *
   * Both providers use the same response format with a limits array containing
   * TOKENS_LIMIT (5-hour usage) and TIME_LIMIT (monthly usage) items.
   *
   * @param data - Raw response data with limits array
   * @param profileId - Profile identifier
   * @param profileName - Profile display name
   * @param profileEmail - Optional email associated with the profile
   * @param providerName - Provider name for logging ('zai' or 'zhipu')
   * @returns Normalized usage snapshot or null on parse failure
   */
  private normalizeQuotaLimitResponse(
    data: any,
    profileId: string,
    profileName: string,
    profileEmail: string | undefined,
    providerName: 'zai' | 'zhipu'
  ): ClaudeUsageSnapshot | null {
    const logPrefix = providerName.toUpperCase();

    if (this.isVerbose) {
      console.warn(`[UsageMonitor:${logPrefix}_NORMALIZATION] Starting normalization:`, {
        profileId,
        profileName,
        responseKeys: Object.keys(data),
        hasLimits: !!data.limits,
        limitsCount: data.limits?.length || 0
      });
    }

    try {
      // Check if response has limits array
      if (!data || !Array.isArray(data.limits)) {
        console.warn(`[UsageMonitor:${logPrefix}] Invalid response format - missing limits array:`, {
          hasData: !!data,
          hasLimits: !!data?.limits,
          limitsType: typeof data?.limits
        });
        return null;
      }

      // Find TOKENS_LIMIT (5-hour usage) and TIME_LIMIT (monthly usage)
      const tokensLimit = data.limits.find((item: any) => item.type === 'TOKENS_LIMIT');
      const timeLimit = data.limits.find((item: any) => item.type === 'TIME_LIMIT');

      if (this.isVerbose) {
        console.warn(`[UsageMonitor:${logPrefix}_NORMALIZATION] Found limit types:`, {
          hasTokensLimit: !!tokensLimit,
          hasTimeLimit: !!timeLimit,
          tokensLimit: tokensLimit ? {
            type: tokensLimit.type,
            unit: tokensLimit.unit,
            number: tokensLimit.number,
            usage: tokensLimit.usage,
            currentValue: tokensLimit.currentValue,
            remaining: tokensLimit.remaining,
            percentage: tokensLimit.percentage,
            nextResetTime: tokensLimit.nextResetTime,
            nextResetDate: tokensLimit.nextResetTime ? new Date(tokensLimit.nextResetTime).toISOString() : undefined
          } : null,
          timeLimit: timeLimit ? {
            type: timeLimit.type,
            percentage: timeLimit.percentage,
            currentValue: timeLimit.currentValue,
            remaining: timeLimit.remaining
          } : null
        });
      }

      // Extract percentages
      const sessionPercent = tokensLimit?.percentage !== undefined
        ? Math.round(tokensLimit.percentage)
        : 0;

      const weeklyPercent = timeLimit?.percentage !== undefined
        ? Math.round(timeLimit.percentage)
        : 0;

      if (this.isVerbose) {
        console.warn(`[UsageMonitor:${logPrefix}_NORMALIZATION] Extracted usage:`, {
          sessionPercent,
          weeklyPercent,
          limitType: weeklyPercent > sessionPercent ? 'weekly' : 'session'
        });
      }

      // Extract reset time from API response
      // The API provides nextResetTime as a Unix timestamp (milliseconds) for TOKENS_LIMIT
      const now = new Date();
      let sessionResetTimestamp: string;

      if (tokensLimit?.nextResetTime && typeof tokensLimit.nextResetTime === 'number') {
        // Use the reset time from the API response (Unix timestamp in ms)
        sessionResetTimestamp = new Date(tokensLimit.nextResetTime).toISOString();
      } else {
        // Fallback: calculate as 5 hours from now
        sessionResetTimestamp = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString();
      }

      // Calculate monthly reset time (1st of next month at midnight UTC)
      const nextMonth = new Date(now);
      nextMonth.setUTCMonth(now.getUTCMonth() + 1, 1);
      nextMonth.setUTCHours(0, 0, 0, 0);
      const weeklyResetTimestamp = nextMonth.toISOString();

      return {
        sessionPercent,
        weeklyPercent,
        // Omit sessionResetTime/weeklyResetTime - renderer uses timestamps with formatTimeRemaining
        sessionResetTime: undefined,
        weeklyResetTime: undefined,
        sessionResetTimestamp,
        weeklyResetTimestamp,
        profileId,
        profileName,
        profileEmail,
        fetchedAt: new Date(),
        limitType: weeklyPercent > sessionPercent ? 'weekly' : 'session',
        usageWindows: {
          sessionWindowLabel: 'common:usage.window5HoursQuota',
          weeklyWindowLabel: 'common:usage.windowMonthlyToolsQuota'
        },
        // Extract raw usage values for display in tooltip
        sessionUsageValue: tokensLimit?.currentValue,
        sessionUsageLimit: tokensLimit?.usage,
        weeklyUsageValue: timeLimit?.currentValue,
        weeklyUsageLimit: timeLimit?.usage
      };
    } catch (error) {
      console.error(`[UsageMonitor:${logPrefix}] Failed to parse quota/limit response:`, error, 'Raw data:', data);
      return null;
    }
  }

  /**
   * Normalize z.ai API response to ClaudeUsageSnapshot
   *
   * Expected endpoint: https://api.z.ai/api/monitor/usage/quota/limit
   *
   * Response format (from empirical testing):
   * {
   *   "data": {
   *     "limits": [
   *       {
   *         "type": "TOKENS_LIMIT",
   *         "percentage": 75.5
   *       },
   *       {
   *         "type": "TIME_LIMIT",
   *         "percentage": 45.2,
   *         "currentValue": 12345,
   *         "usage": 50000,
   *         "usageDetails": {...}
   *       }
   *     ]
   *   }
   * }
   *
   * Maps TOKENS_LIMIT → session usage (5-hour window)
   * Maps TIME_LIMIT → monthly usage (displayed as weekly in UI)
   */
  private normalizeZAIResponse(
    data: any,
    profileId: string,
    profileName: string,
    profileEmail?: string
  ): ClaudeUsageSnapshot | null {
    // Delegate to shared quota/limit response normalization
    return this.normalizeQuotaLimitResponse(data, profileId, profileName, profileEmail, 'zai');
  }

  /**
   * Normalize ZHIPU AI response to ClaudeUsageSnapshot
   *
   * Expected endpoint: https://open.bigmodel.cn/api/monitor/usage/quota/limit
   *
   * Uses the same response format as z.ai with limits array containing
   * TOKENS_LIMIT and TIME_LIMIT items.
   */
  private normalizeZhipuResponse(
    data: any,
    profileId: string,
    profileName: string,
    profileEmail?: string
  ): ClaudeUsageSnapshot | null {
    // Delegate to shared quota/limit response normalization
    return this.normalizeQuotaLimitResponse(data, profileId, profileName, profileEmail, 'zhipu');
  }

  /**
   * Fetch usage via CLI /usage command (fallback)
   * Note: This is a fallback method. The API method is preferred.
   * CLI-based fetching would require spawning a Claude process and parsing output,
   * which is complex. For now, we rely on the API method.
   */
  private async fetchUsageViaCLI(
    _profileId: string,
    _profileName: string
  ): Promise<ClaudeUsageSnapshot | null> {
    // CLI-based usage fetching is not implemented yet.
    // The API method should handle most cases. If we need CLI fallback,
    // we would need to spawn a Claude process with /usage command and parse the output.
    // CLI-based usage fetching is intentionally not implemented.
    // The API method handles all cases; this fallback path is expected when API is rate-limited or unavailable.
    return null;
  }
}

/**
 * Get the singleton UsageMonitor instance
 */
export function getUsageMonitor(): UsageMonitor {
  return UsageMonitor.getInstance();
}
