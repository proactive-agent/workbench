/**
 * Usage Indicator - Real-time Claude usage display in header
 *
 * Displays current session/weekly usage as a badge with color-coded status.
 * - Hover to show breakdown popup (auto-closes on mouse leave)
 * - Click to pin popup open (stays until clicking outside)
 *
 * Supports all providers from the global priority queue:
 * - Anthropic OAuth (subscription): shows session/weekly usage bars
 * - Non-Anthropic subscription accounts (e.g. OpenAI Codex OAuth): shows "Subscription" badge
 *   with a note that rate limits apply but monitoring is not yet available
 * - API key providers: checks the key with the provider and shows "API key" (pay as you go)
 *   or "Invalid key"; local providers (Ollama) show "Local"
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { Activity, TrendingUp, AlertCircle, Clock, Info, LogIn } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './ui/popover';
import { useTranslation } from 'react-i18next';
import { formatTimeRemaining, localizeUsageWindowLabel, hasHardcodedText } from '../../shared/utils/format-time';
import type { ClaudeUsageSnapshot } from '../../shared/types/agent';
import type { AppSection } from './settings/AppSettings';
import { useActiveProvider } from '../hooks/useActiveProvider';
import { PROVIDER_REGISTRY } from '../../shared/constants/providers';
import type { ProviderKeyCheckResult } from '../../shared/types/provider-account';

/**
 * Usage threshold constants for color coding
 */
const THRESHOLD_CRITICAL = 95;  // Red: At or near limit
const THRESHOLD_WARNING = 91;   // Orange: Very high usage
const THRESHOLD_ELEVATED = 71;  // Yellow: Moderate usage
// Below 71 is considered normal (green)

const PROVIDER_BADGE_COLORS: Record<string, string> = {
  'anthropic': 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  'openai': 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  'google': 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  'mistral': 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  'groq': 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  'xai': 'bg-slate-500/10 text-slate-500 border-slate-500/20',
  'amazon-bedrock': 'bg-orange-600/10 text-orange-600 border-orange-600/20',
  'azure': 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  'ollama': 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  'openai-compatible': 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  'zai': 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
  'openrouter': 'bg-violet-500/10 text-violet-500 border-violet-500/20',
};

/**
 * Get color class based on usage percentage
 */
const getColorClass = (percent: number): string => {
  if (percent >= THRESHOLD_CRITICAL) return 'text-red-500';
  if (percent >= THRESHOLD_WARNING) return 'text-orange-500';
  if (percent >= THRESHOLD_ELEVATED) return 'text-yellow-500';
  return 'text-green-500';
};

/**
 * Get background/border color classes for badges based on usage percentage
 */
const getBadgeColorClasses = (percent: number): string => {
  if (percent >= THRESHOLD_CRITICAL) return 'text-red-500 bg-red-500/10 border-red-500/20';
  if (percent >= THRESHOLD_WARNING) return 'text-orange-500 bg-orange-500/10 border-orange-500/20';
  if (percent >= THRESHOLD_ELEVATED) return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
  return 'text-green-500 bg-green-500/10 border-green-500/20';
};

/**
 * Get gradient background class based on usage percentage
 */
const getGradientClass = (percent: number): string => {
  if (percent >= THRESHOLD_CRITICAL) return 'bg-gradient-to-r from-red-600 to-red-500';
  if (percent >= THRESHOLD_WARNING) return 'bg-gradient-to-r from-orange-600 to-orange-500';
  if (percent >= THRESHOLD_ELEVATED) return 'bg-gradient-to-r from-yellow-600 to-yellow-500';
  return 'bg-gradient-to-r from-green-600 to-green-500';
};

/**
 * Check whether a provider account supports real-time usage monitoring.
 * Currently: Anthropic OAuth, OpenAI OAuth, and Z.AI API key accounts.
 */
const accountHasUsageMonitoring = (account: { provider: string; authType?: string; apiKey?: string }): boolean => {
  if ((account.provider === 'anthropic' || account.provider === 'openai') && account.authType === 'oauth') return true;
  if (account.provider === 'zai' && account.apiKey) return true;
  return false;
};

export function UsageIndicator() {
  const { t, i18n } = useTranslation(['common']);
  const [usage, setUsage] = useState<ClaudeUsageSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAvailable, setIsAvailable] = useState(false);
  const [activeProfileNeedsReauth, setActiveProfileNeedsReauth] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // The badge sits inside the sidebar footer; open the breakdown above the whole footer with the
  // same 0.5rem gap it keeps from the sidebar's sides (rem-based so it follows the UI scale)
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverOffset, setPopoverOffset] = useState(8);
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!isOpen || !trigger?.parentElement) return;
    const gap = 0.5 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    const footerTop = trigger.parentElement.getBoundingClientRect().top;
    setPopoverOffset(Math.round(trigger.getBoundingClientRect().top - footerTop + gap));
  }, [isOpen]);

  const { account: activeAccount } = useActiveProvider();

  // Usage monitoring is available for Anthropic/OpenAI OAuth accounts and Z.AI API key accounts
  const hasUsageMonitoring = activeAccount ? accountHasUsageMonitoring(activeAccount) : false;
  // Subscription accounts (any provider) have rate limits even though we can't monitor them
  const hasSubscriptionLimits = activeAccount?.billingModel === 'subscription';

  /**
   * Helper function to format large numbers with locale-aware compact notation
   */
  const formatUsageValue = (value?: number | null): string | undefined => {
    if (value == null) return undefined;

    if (typeof Intl !== 'undefined' && Intl.NumberFormat) {
      try {
        return new Intl.NumberFormat(i18n.language, {
          notation: 'compact',
          compactDisplay: 'short',
          maximumFractionDigits: 2
        }).format(value);
      } catch {
        // Intl may fail in some environments, fall back to toString()
      }
    }
    return value.toString();
  };

  /**
   * Navigate to settings accounts tab
   */
  const handleOpenAccounts = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Close the popover first
    setIsOpen(false);
    setIsPinned(false);
    // Dispatch custom event to open settings with accounts section
    // Small delay to allow popover to close first
    setTimeout(() => {
      const event = new CustomEvent<AppSection>('open-app-settings', {
        detail: 'accounts'
      });
      window.dispatchEvent(event);
    }, 100);
  }, []);

  /**
   * Handle mouse enter - show popup after short delay (unless pinned)
   */
  const handleMouseEnter = useCallback(() => {
    if (isPinned) return;
    // Clear any pending close timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    // Open after short delay for smoother UX
    hoverTimeoutRef.current = setTimeout(() => {
      setIsOpen(true);
    }, 150);
  }, [isPinned]);

  /**
   * Handle mouse leave - close popup after delay (unless pinned)
   */
  const handleMouseLeave = useCallback(() => {
    if (isPinned) return;
    // Clear any pending open timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    // Close after delay to allow moving to popup content
    hoverTimeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 300);
  }, [isPinned]);

  /**
   * Handle click on trigger - toggle pinned state
   */
  const handleTriggerClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (isPinned) {
      // Clicking when pinned unpins and closes
      setIsPinned(false);
      setIsOpen(false);
    } else {
      // Clicking when not pinned pins it open
      setIsPinned(true);
      setIsOpen(true);
    }
  }, [isPinned]);

  /**
   * Handle popover open change (e.g., clicking outside)
   */
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      // Closing from outside click
      setIsOpen(false);
      setIsPinned(false);
    }
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // Get formatted reset times (calculated dynamically from timestamps)
  const sessionResetTime = usage?.sessionResetTimestamp
    ? (formatTimeRemaining(usage.sessionResetTimestamp, t) ??
      (hasHardcodedText(usage?.sessionResetTime) ? undefined : usage?.sessionResetTime))
    : (hasHardcodedText(usage?.sessionResetTime) ? undefined : usage?.sessionResetTime);
  const weeklyResetTime = usage?.weeklyResetTimestamp
    ? (formatTimeRemaining(usage.weeklyResetTimestamp, t) ??
      (hasHardcodedText(usage?.weeklyResetTime) ? undefined : usage?.weeklyResetTime))
    : (hasHardcodedText(usage?.weeklyResetTime) ? undefined : usage?.weeklyResetTime);

  useEffect(() => {
    // Listen for usage updates from main process
    const unsubscribe = window.electronAPI.onUsageUpdated((snapshot: ClaudeUsageSnapshot) => {
      setUsage(snapshot);
      setIsAvailable(true);
      setIsLoading(false);
    });

    // Listen for all profiles usage updates (to know whether the active profile needs re-auth)
    const unsubscribeAllProfiles = window.electronAPI.onAllProfilesUsageUpdated?.((allProfilesUsage) => {
      // Track if active profile needs re-auth
      const activeProfile = allProfilesUsage.allProfiles.find(p => p.isActive);
      setActiveProfileNeedsReauth(activeProfile?.needsReauthentication ?? false);
    });

    // Request initial usage on mount
    window.electronAPI.requestUsageUpdate().then((result) => {
      setIsLoading(false);
      if (result.success && result.data) {
        setUsage(result.data);
        setIsAvailable(true);
      } else {
        setIsAvailable(false);
      }
    }).catch(() => {
      setIsLoading(false);
      setIsAvailable(false);
    });

    // Request all profiles usage immediately on mount (re-auth state for the active profile)
    window.electronAPI.requestAllProfilesUsage?.().then((result) => {
      if (result.success && result.data) {
        // Track if active profile needs re-auth (even if main usage is unavailable)
        const activeProfile = result.data.allProfiles.find(p => p.isActive);
        if (activeProfile?.needsReauthentication) {
          setActiveProfileNeedsReauth(true);
        }
      }
    }).catch(() => {
      // Silently ignore
    });

    return () => {
      unsubscribe();
      unsubscribeAllProfiles?.();
    };
  }, []);

  // API key accounts have no usage data: check the key with its provider instead (on account
  // change, and again when the breakdown opens if the last check is over a minute old)
  const isApiKeyAccount = !!activeAccount && !hasUsageMonitoring && !hasSubscriptionLimits && activeAccount.provider !== 'ollama';
  const [keyCheck, setKeyCheck] = useState<{ key: string; result: ProviderKeyCheckResult | null; at: number } | null>(null);
  const keyCheckId = isApiKeyAccount ? `${activeAccount.id}:${activeAccount.apiKey ?? ''}:${activeAccount.baseUrl ?? ''}` : null;
  const runKeyCheck = useCallback(() => {
    if (!keyCheckId || !activeAccount) return;
    setKeyCheck({ key: keyCheckId, result: null, at: Date.now() });
    window.electronAPI.testProviderConnection(activeAccount.provider, {
      apiKey: activeAccount.apiKey,
      baseUrl: activeAccount.baseUrl,
    }).then((res) => {
      const result: ProviderKeyCheckResult = res.success && res.data ? res.data : { status: 'unreachable', error: res.error };
      setKeyCheck((prev) => (prev?.key === keyCheckId ? { ...prev, result } : prev));
    }).catch(() => {
      setKeyCheck((prev) => (prev?.key === keyCheckId ? { ...prev, result: { status: 'unreachable' } } : prev));
    });
  }, [keyCheckId]);
  useEffect(() => {
    runKeyCheck();
  }, [runKeyCheck]);
  useEffect(() => {
    if (isOpen && keyCheck?.result && Date.now() - keyCheck.at > 60_000) runKeyCheck();
  }, [isOpen]);

  // Show loading state - only for Anthropic OAuth accounts awaiting usage data
  if (isLoading && hasUsageMonitoring) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-muted/50 text-muted-foreground">
        <Activity className="h-3.5 w-3.5 motion-safe:animate-pulse" />
        <span className="text-xs font-semibold">{t('common:usage.loading')}</span>
      </div>
    );
  }

  // For subscription accounts without monitoring (e.g. OpenAI Codex OAuth), show "Subscription" badge
  if (!hasUsageMonitoring && hasSubscriptionLimits) {
    const providerBadgeColor = PROVIDER_BADGE_COLORS[activeAccount?.provider ?? ''] ?? PROVIDER_BADGE_COLORS['openai-compatible'];
    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-md border transition-all hover:opacity-80 ${providerBadgeColor}`}
            aria-label={t('common:usage.usageStatusAriaLabel')}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={handleTriggerClick}
          >
            <Activity className="h-3.5 w-3.5" />
            <span className="text-xs font-semibold">{t('common:usage.subscriptionBadge')}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={popoverOffset}
          className="text-xs w-[17rem] p-0 max-h-[80vh] overflow-y-auto"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
            <div className="p-3 space-y-3">
              <div className="flex items-center gap-1.5 pb-2 border-b">
                <Activity className="h-3.5 w-3.5" />
                <span className="font-semibold text-xs">{t('common:usage.usageBreakdown')}</span>
              </div>
            <div className="flex items-start gap-2.5 py-3">
              <Info className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-medium">{t('common:usage.subscriptionLimitsApply')}</p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {t('common:usage.subscriptionMonitoringComingSoon')}
                </p>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // API key (pay-as-you-go) and local providers: no usage limits to track
  if (!hasUsageMonitoring && !hasSubscriptionLimits) {
    const providerName = PROVIDER_REGISTRY.find((p) => p.id === activeAccount?.provider)?.name ?? activeAccount?.provider ?? '';
    const status = isApiKeyAccount ? (keyCheck?.key === keyCheckId ? keyCheck?.result?.status ?? 'checking' : 'checking') : 'local';
    const isInvalid = status === 'invalid';
    const badgeLabel = status === 'local'
      ? t('common:usage.localBadge')
      : isInvalid
        ? t('common:usage.invalidKeyBadge')
        : t('common:usage.apiKeyBadge');
    const badgeColor = isInvalid
      ? 'text-red-500 bg-red-500/10 border-red-500/20'
      : 'text-muted-foreground bg-muted/50 border-border';
    const message = {
      checking: t('common:usage.apiKeyChecking', { provider: providerName }),
      valid: t('common:usage.apiKeyValid', { provider: providerName }),
      invalid: t('common:usage.apiKeyInvalid', { provider: providerName }),
      unreachable: t('common:usage.apiKeyUnreachable', { provider: providerName }),
      unknown: t('common:usage.apiKeyUnknown', { provider: providerName }),
      local: t('common:usage.localNoLimits'),
    }[status];

    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-md border transition-all hover:opacity-80 ${badgeColor}`}
            aria-label={t('common:usage.usageStatusAriaLabel')}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={handleTriggerClick}
          >
            {isInvalid ? <AlertCircle className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
            <span className="text-xs font-semibold">{badgeLabel}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={popoverOffset}
          className="text-xs w-[17rem] p-0 max-h-[80vh] overflow-y-auto"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="p-3 space-y-3">
            <div className="flex items-center gap-1.5 pb-2 border-b">
              <Activity className="h-3.5 w-3.5" />
              <span className="font-semibold text-xs">{t('common:usage.usageBreakdown')}</span>
            </div>
            <div className="flex items-start gap-2.5 py-1">
              {isInvalid
                ? <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                : <Info className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />}
              <div className="min-w-0 space-y-1">
                <p className="truncate text-xs font-medium">{activeAccount?.name} · {providerName}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">{message}</p>
              </div>
            </div>
            {isInvalid && (
              <button
                type="button"
                onClick={handleOpenAccounts}
                className="w-full rounded-md bg-muted/60 px-2 py-1.5 text-xs font-medium hover:bg-muted"
              >
                {t('common:usage.manageAccounts')}
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // Show unavailable state — but still allow account swapping via popover
  if (!isAvailable || !usage) {
    const needsReauth = activeProfileNeedsReauth;

    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-all hover:opacity-80 ${
              needsReauth
                ? 'bg-red-500/10 border-red-500/20 text-red-500'
                : 'bg-muted/50 text-muted-foreground'
            }`}
            aria-label={needsReauth ? t('common:usage.reauthRequired') : t('common:usage.dataUnavailable')}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={handleTriggerClick}
          >
            {needsReauth ? (
              <>
                <AlertCircle className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold">!</span>
              </>
            ) : (
              <>
                <Activity className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold">{t('common:usage.notAvailable')}</span>
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={popoverOffset}
          className="text-xs w-[17rem] p-0 max-h-[80vh] overflow-y-auto"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="p-3 space-y-3">
            <div className="flex items-center gap-1.5 pb-2 border-b">
              <Activity className="h-3.5 w-3.5" />
              <span className="font-semibold text-xs">{t('common:usage.usageBreakdown')}</span>
            </div>

            {/* Status message */}
            <div className="flex items-start gap-2.5 py-2">
              {needsReauth ? (
                <>
                  <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-red-500">{t('common:usage.reauthRequired')}</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {t('common:usage.reauthRequiredDescription')}
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <Info className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-xs font-medium">{t('common:usage.dataUnavailable')}</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {t('common:usage.dataUnavailableDescription')}
                    </p>
                  </div>
                </>
              )}
            </div>
        </div>
      </PopoverContent>
      </Popover>
    );
  }

  // Determine colors and labels based on the LIMITING factor (higher of session/weekly)
  const sessionPercent = usage.sessionPercent;
  const weeklyPercent = usage.weeklyPercent;
  const limitingPercent = Math.max(sessionPercent, weeklyPercent);

  // Badge color based on the limiting (higher) percentage
  // Override to red/destructive when re-auth is needed
  const badgeColorClasses = usage.needsReauthentication
    ? 'text-red-500 bg-red-500/10 border-red-500/20'
    : getBadgeColorClasses(limitingPercent);

  // Individual colors for session and weekly in the badge
  const sessionColorClass = getColorClass(sessionPercent);
  const weeklyColorClass = getColorClass(weeklyPercent);

  const sessionLabel = localizeUsageWindowLabel(
    usage?.usageWindows?.sessionWindowLabel,
    t,
    'common:usage.sessionDefault'
  );
  const weeklyLabel = localizeUsageWindowLabel(
    usage?.usageWindows?.weeklyWindowLabel,
    t,
    'common:usage.weeklyDefault'
  );

  const maxUsage = Math.max(usage.sessionPercent, usage.weeklyPercent);
  // Show AlertCircle when re-auth needed or high usage
  const Icon = usage.needsReauthentication ? AlertCircle :
    maxUsage >= THRESHOLD_WARNING ? AlertCircle :
    maxUsage >= THRESHOLD_ELEVATED ? TrendingUp :
    Activity;

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          className={`inline-flex h-7 items-center justify-center gap-1 px-2 rounded-md border leading-none transition-all hover:opacity-80 ${badgeColorClasses}`}
          aria-label={t('common:usage.usageStatusAriaLabel')}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={handleTriggerClick}
        >
          <Icon className="h-3.5 w-3.5 flex-shrink-0" />
          {/* Show "!" when re-auth needed, otherwise dual usage display */}
          {usage.needsReauthentication ? (
            <span className="text-xs font-semibold text-red-500" title={t('common:usage.needsReauth')}>
              !
            </span>
          ) : (
            <div className="flex items-center justify-center gap-0.5 text-xs font-semibold font-mono leading-none tabular-nums">
              <span className={sessionColorClass} title={t('common:usage.sessionShort')}>
                {Math.round(sessionPercent)}
              </span>
              {/* Hairline divider (a bold monospace "|" renders too heavy) */}
              <span aria-hidden="true" className="mx-0.5 h-3 w-px bg-muted-foreground/40" />
              <span className={weeklyColorClass} title={t('common:usage.weeklyShort')}>
                {Math.round(weeklyPercent)}
              </span>
            </div>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={popoverOffset}
        className="text-xs w-[17rem] p-0 max-h-[80vh] overflow-y-auto"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="p-3 space-y-3">
          {/* Header with overall status */}
          <div className="flex items-center gap-1.5 pb-2 border-b">
            <Icon className="h-3.5 w-3.5" />
            <span className="font-semibold text-xs">{t('common:usage.usageBreakdown')}</span>
          </div>

          {/* Re-auth required prompt - shown when active profile needs re-authentication */}
          {usage.needsReauthentication ? (
            <div className="py-2 space-y-3">
              <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-destructive/10 border border-destructive/20">
                <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-xs font-medium text-destructive">
                    {t('common:usage.reauthRequired')}
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    {t('common:usage.reauthRequiredDescription')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleOpenAccounts}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors text-xs font-medium"
              >
                <LogIn className="h-3.5 w-3.5" />
                {t('common:usage.reauthButton')}
              </button>
            </div>
          ) : (
            <>
              {/* Session/5-hour usage */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground font-medium text-[11px] flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {sessionLabel}
                  </span>
                  <span className={`font-semibold tabular-nums text-xs ${getColorClass(usage.sessionPercent).replace('500', '600')}`}>
                    {Math.round(usage.sessionPercent)}%
                  </span>
                </div>
                {sessionResetTime && (
                  <div className="text-[10px] text-muted-foreground pl-4 flex items-center gap-1">
                    <Info className="h-2.5 w-2.5" />
                    {sessionResetTime}
                  </div>
                )}
                <div className="h-2 bg-muted rounded-full overflow-hidden shadow-inner">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ease-out relative overflow-hidden ${getGradientClass(usage.sessionPercent)}`}
                    style={{ width: `${Math.min(usage.sessionPercent, 100)}%` }}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent motion-safe:animate-pulse" />
                  </div>
                </div>
                {usage.sessionUsageValue != null && usage.sessionUsageLimit != null && (
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-muted-foreground">{t('common:usage.used')}</span>
                    <span className="font-medium tabular-nums">
                      {formatUsageValue(usage.sessionUsageValue)} <span className="text-muted-foreground mx-1">/</span> {formatUsageValue(usage.sessionUsageLimit)}
                    </span>
                  </div>
                )}
              </div>

              {/* Weekly/Monthly usage */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground font-medium text-[11px] flex items-center gap-1">
                    <TrendingUp className="h-3 w-3" />
                    {weeklyLabel}
                  </span>
                  <span className={`font-semibold tabular-nums text-xs ${getColorClass(usage.weeklyPercent).replace('500', '600')}`}>
                    {Math.round(usage.weeklyPercent)}%
                  </span>
                </div>
                {weeklyResetTime && (
                  <div className="text-[10px] text-muted-foreground pl-4 flex items-center gap-1">
                    <Info className="h-2.5 w-2.5" />
                    {weeklyResetTime}
                  </div>
                )}
                <div className="h-2 bg-muted rounded-full overflow-hidden shadow-inner">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ease-out relative overflow-hidden ${getGradientClass(usage.weeklyPercent)}`}
                    style={{ width: `${Math.min(usage.weeklyPercent, 100)}%` }}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent motion-safe:animate-pulse" />
                  </div>
                </div>
                {usage.weeklyUsageValue != null && usage.weeklyUsageLimit != null && (
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-muted-foreground">{t('common:usage.used')}</span>
                    <span className="font-medium tabular-nums">
                      {formatUsageValue(usage.weeklyUsageValue)} <span className="text-muted-foreground mx-1">/</span> {formatUsageValue(usage.weeklyUsageLimit)}
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
