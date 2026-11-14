/**
 * Monthly spend limits: what Enterprise accounts have instead of the 5-hour and weekly windows
 * (ClaudeUsageSnapshot.spendLimit, read in the main process's usage monitor)
 */

import type { UsageSpendLimit } from '../../../shared/types/agent';

/** An amount in the limit's currency, as the user's locale writes money ("$136.22") */
export function formatSpend(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    // A currency code Intl doesn't know
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** A pretend Enterprise limit for the usage simulator's previews when the real account has none */
export const SAMPLE_SPEND_LIMIT: UsageSpendLimit = { used: 0, limit: 250, currency: 'USD' };
