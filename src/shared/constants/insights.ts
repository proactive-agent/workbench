/**
 * Insights chat constants shared by the main process (which raises errors) and the
 * renderer (which translates them).
 */

/**
 * Error codes prefixed to Insights error messages as `[code] details`, so the renderer can
 * show a translated explanation and keep the provider's details as secondary text.
 */
export const INSIGHTS_ERROR_CODES = {
  /**
   * Anthropic answered HTTP 429 `rate_limit_error` with the bare message "Error".
   * This is what the Messages API returns when a Claude subscription (OAuth) token is used
   * by a client it doesn't accept, not a genuine usage limit.
   */
  subscriptionRejected: 'subscription_rejected',
  /** Subscription accounts run Insights through the Claude Code CLI, which isn't installed */
  claudeCodeMissing: 'claude_code_missing'
} as const;

export type InsightsErrorCode = (typeof INSIGHTS_ERROR_CODES)[keyof typeof INSIGHTS_ERROR_CODES];

/** Build an Insights error message carrying a code */
export function formatInsightsError(code: InsightsErrorCode, details: string): string {
  return `[${code}] ${details}`;
}

/** Split an Insights error message into its code (if any) and details */
export function parseInsightsError(message: string): { code: InsightsErrorCode | null; details: string } {
  const match = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(message);
  const codes = Object.values(INSIGHTS_ERROR_CODES) as string[];
  if (match && codes.includes(match[1])) {
    return { code: match[1] as InsightsErrorCode, details: match[2] };
  }
  return { code: null, details: message };
}
