/**
 * Rate limit detection utility for Claude CLI/SDK calls.
 * Detects rate limit errors in stdout/stderr output and provides context.
 */

import { getClaudeProfileManager } from './claude-profile-manager';
import { debugLog } from '../shared/utils/debug-logger';
import { findStandaloneLimitReset } from './claude-profile/rate-limit-manager';
import { appLog } from './app-logger';

/**
 * Regex pattern to detect Claude Code rate limit messages
 * Matches: "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"
 */
const RATE_LIMIT_PATTERN = /Limit reached\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im;

/**
 * Additional patterns that might indicate rate limiting
 */
const RATE_LIMIT_INDICATORS = [
  /rate\s*limit/i,
  /usage\s*limit/i,
  /limit\s*reached/i,
  /exceeded.*limit/i,
  /too\s*many\s*requests/i,
];

/**
 * Maximum length for error messages sent to renderer.
 * Truncates to prevent exposing excessive internal details.
 */
const MAX_ERROR_LENGTH = 500;

/**
 * Sanitize error output before sending to renderer.
 * Truncates long output to prevent exposing excessive internal details
 * like full paths, API responses, or stack traces.
 */
function sanitizeErrorOutput(output: string): string {
  // Truncate long output to limit exposure of internal details
  if (output.length > MAX_ERROR_LENGTH) {
    return output.substring(0, MAX_ERROR_LENGTH) + '... (truncated)';
  }
  return output;
}

/**
 * Result of rate limit detection
 */
export interface RateLimitDetectionResult {
  /** Whether a rate limit was detected */
  isRateLimited: boolean;
  /** The reset time string if detected (e.g., "Dec 17 at 6am (Europe/Oslo)") */
  resetTime?: string;
  /** Type of limit: 'session' (5-hour) or 'weekly' (7-day) */
  limitType?: 'session' | 'weekly';
  /** The profile ID that hit the limit (if known) */
  profileId?: string;
  /** Original error message (truncated to 500 chars for security) */
  originalError?: string;
}

/**
 * Classify rate limit type based on reset time string
 */
function classifyLimitType(resetTimeStr: string): 'session' | 'weekly' {
  // Weekly limits mention specific dates like "Dec 17" or "Nov 1"
  // Session limits are typically just times like "11:59pm"
  const hasDate = /[A-Za-z]{3}\s+\d+/i.test(resetTimeStr);
  const hasWeeklyIndicator = resetTimeStr.toLowerCase().includes('week');

  return (hasDate || hasWeeklyIndicator) ? 'weekly' : 'session';
}

/**
 * Detect rate limit from output (stdout + stderr combined)
 */
export function detectRateLimit(
  output: string,
  profileId?: string
): RateLimitDetectionResult {
  // Check for the primary rate limit pattern. It only counts when the message stands on its own
  // line: the same words quoted in model output or code must not mark the account as limited.
  const resetTime = RATE_LIMIT_PATTERN.test(output) ? findStandaloneLimitReset(output) : null;

  if (resetTime) {
    const limitType = classifyLimitType(resetTime);

    // Record the rate limit event in the profile manager
    const profileManager = getClaudeProfileManager();
    const effectiveProfileId = profileId || profileManager.getActiveProfile().id;

    try {
      profileManager.recordRateLimitEvent(effectiveProfileId, resetTime);
    } catch (err) {
      console.error('[RateLimitDetector] Failed to record rate limit event:', err);
    }

    return {
      isRateLimited: true,
      resetTime,
      limitType,
      profileId: effectiveProfileId,
      originalError: sanitizeErrorOutput(output)
    };
  }

  // Check for secondary rate limit indicators
  for (const pattern of RATE_LIMIT_INDICATORS) {
    if (pattern.test(output)) {
      const profileManager = getClaudeProfileManager();
      const effectiveProfileId = profileId || profileManager.getActiveProfile().id;

      return {
        isRateLimited: true,
        profileId: effectiveProfileId,
        originalError: sanitizeErrorOutput(output)
      };
    }
  }

  return { isRateLimited: false };
}

/** Whether an account is a Claude Code setup found in its own configuration */
export function isDetectedClaudeCodeProfile(profileId: string): boolean {
  return !!getClaudeProfileManager().getProfile(profileId)?.detected;
}

/**
 * Environment for a specific profile, or null when that profile no longer exists or has no
 * credentials (callers then fall back to the account in use, see getRunnableProfileEnv).
 */
export function getUsableProfileEnv(profileId: string): Record<string, string> | null {
  const profileManager = getClaudeProfileManager();
  if (!profileManager.getProfile(profileId) || !profileManager.hasValidAuth(profileId)) {
    return null;
  }
  return profileManager.getProfileEnv(profileId);
}

/**
 * Result of getting the environment of the account a run uses
 */
interface RunnableProfileEnvResult {
  /** Environment variables for the selected profile */
  env: Record<string, string>;
  /** The profile ID that was selected */
  profileId: string;
  /** The profile name for logging/display */
  profileName: string;
  /** The account in use can't run at all (no credentials), so a signed-in one was used instead */
  wasSignedOut: boolean;
}

/**
 * Environment for the account in use, for runs that name no account (or whose account was
 * removed or signed out).
 *
 * Runs stay on the account in use, also while it is rate limited or at its usage limit (they
 * wait for the reset). The only exception: an account that can't run at all (e.g. an "Add
 * account" sign-in that never finished) is replaced by a signed-in one, which also becomes the
 * account in use, since every run on it could only fail.
 */
export function getRunnableProfileEnv(): RunnableProfileEnvResult {
  const profileManager = getClaudeProfileManager();
  const activeProfile = profileManager.getActiveProfile();

  // A profile without a config dir uses the default credentials and is left alone
  const isSignedOut = !!activeProfile.configDir && !profileManager.hasValidAuth(activeProfile.id);
  if (isSignedOut) {
    const signedIn = profileManager.getSettings().profiles.find(
      (profile) => profile.id !== activeProfile.id && profileManager.hasValidAuth(profile.id)
    );
    if (signedIn) {
      profileManager.setActiveProfile(signedIn.id);
      appLog.warn(`[RateLimitDetector] Account "${activeProfile.name}" has no credentials, using "${signedIn.name}"`);
      return {
        env: ensureCleanProfileEnv(profileManager.getProfileEnv(signedIn.id)),
        profileId: signedIn.id,
        profileName: signedIn.name,
        wasSignedOut: true
      };
    }
    debugLog('[RateLimitDetector] Active account has no credentials and no other account is signed in');
  }

  return {
    env: ensureCleanProfileEnv(profileManager.getActiveProfileEnv()),
    profileId: activeProfile.id,
    profileName: activeProfile.name,
    wasSignedOut: false
  };
}

/**
 * Ensure the profile environment is clean for subprocess invocation.
 *
 * When CLAUDE_CONFIG_DIR is set, we MUST clear both CLAUDE_CODE_OAUTH_TOKEN and
 * ANTHROPIC_API_KEY to prevent the Claude Agent SDK from using hardcoded/cached
 * tokens or API keys (e.g., from .env file or shell environment) instead of reading
 * fresh credentials from the specified config directory.
 *
 * ANTHROPIC_API_KEY is cleared to prevent Claude Code from using API keys present
 * in the shell environment, which would cause it to show "Claude API" instead of
 * "Claude Max" and bypass the intended config dir credentials.
 *
 * This is critical with several accounts: the subprocess must use the chosen account's
 * credentials.
 *
 * Also warns if the profile env is empty, which indicates a misconfigured profile.
 *
 * @param env - Profile environment from getProfileEnv() or getActiveProfileEnv()
 * @returns Environment with CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY cleared if CLAUDE_CONFIG_DIR is set
 */
export function ensureCleanProfileEnv(env: Record<string, string>): Record<string, string> {
  debugLog('[RateLimitDetector] ensureCleanProfileEnv() input:', {
    hasClaudeConfigDir: !!env.CLAUDE_CONFIG_DIR,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR,
    hasOAuthToken: !!env.CLAUDE_CODE_OAUTH_TOKEN,
    willClearOAuthToken: !!env.CLAUDE_CONFIG_DIR,
    willClearApiKey: !!env.CLAUDE_CONFIG_DIR,
  });

  // Warn if the profile environment is empty — this likely indicates a misconfigured profile
  if (Object.keys(env).length === 0) {
    console.warn('[RateLimitDetector] ensureCleanProfileEnv() received empty profile env — profile may be misconfigured');
  }

  if (env.CLAUDE_CONFIG_DIR) {
    // Clear CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY to ensure SDK uses credentials from CLAUDE_CONFIG_DIR
    // ANTHROPIC_API_KEY must also be cleared to prevent Claude Code from using
    // API keys that may be present in the shell environment instead of the config dir credentials.
    const cleanedEnv = {
      ...env,
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_API_KEY: ''
    };

    debugLog('[RateLimitDetector] ensureCleanProfileEnv() output:', {
      claudeConfigDirPreserved: 'CLAUDE_CONFIG_DIR' in cleanedEnv,
      claudeConfigDir: (cleanedEnv as Record<string, string>).CLAUDE_CONFIG_DIR,
      oauthTokenCleared: cleanedEnv.CLAUDE_CODE_OAUTH_TOKEN === '',
      envKeys: Object.keys(cleanedEnv),
    });

    return cleanedEnv;
  }
  return env;
}

/**
 * Information about a rate limit event for the UI
 */
export interface SDKRateLimitInfo {
  /** Source of the rate limit (which feature hit it) */
  source: 'task' | 'title-generator' | 'other';
  /** Project ID if applicable */
  projectId?: string;
  /** Task ID if applicable */
  taskId?: string;
  /** The reset time string */
  resetTime?: string;
  /** Type of limit */
  limitType?: 'session' | 'weekly';
  /** Profile that hit the limit */
  profileId: string;
  /** Profile name for display */
  profileName?: string;
  /** When detected */
  detectedAt: Date;
  /** Original error message (truncated to 500 chars for security) */
  originalError?: string;
}

/**
 * Create SDK rate limit info object for emitting to UI
 */
export function createSDKRateLimitInfo(
  source: SDKRateLimitInfo['source'],
  detection: RateLimitDetectionResult,
  options?: {
    projectId?: string;
    taskId?: string;
  }
): SDKRateLimitInfo {
  const profileManager = getClaudeProfileManager();
  const profile = detection.profileId
    ? profileManager.getProfile(detection.profileId)
    : profileManager.getActiveProfile();

  return {
    source,
    projectId: options?.projectId,
    taskId: options?.taskId,
    resetTime: detection.resetTime,
    limitType: detection.limitType,
    profileId: detection.profileId || profileManager.getActiveProfile().id,
    profileName: profile?.name,
    detectedAt: new Date(),
    originalError: detection.originalError
  };
}
