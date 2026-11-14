/**
 * Usage Indicator - Real-time Claude usage display in header
 *
 * Displays current session/weekly usage as a badge with color-coded status.
 * - Hover to show breakdown popup (auto-closes on mouse leave)
 * - Click to pin popup open (stays until clicking outside)
 *
 * - Claude accounts (subscription): shows session/weekly usage bars; Enterprise accounts, which
 *   have a monthly spend limit instead, show the share of it spent
 * - An active API profile (Anthropic-compatible endpoint): shows "API key" (pay as you go)
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { Activity, TrendingUp, AlertCircle } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './ui/popover';
import { useTranslation } from 'react-i18next';
import type { ClaudeUsageSnapshot, ProfileUsageSummary } from '../../shared/types/agent';
import type { AppSection } from './settings/AppSettings';
import { useSettingsStore } from '../stores/settings-store';
import { cn } from '../lib/utils';
import { UsageBreakdown } from './usage/UsageBreakdown';
import { ApiProfileUsageCard, ReauthRequiredCard, UsageUnavailableCard } from './usage/UsageStateCards';
import { useUsageStore } from '../stores/usage-store';
import { useClaudeProfileStore } from '../stores/claude-profile-store';
import { useWindowClaudeAccountId } from '../hooks/useWindowClaudeAccount';
import {
  THRESHOLD_ELEVATED, THRESHOLD_WARNING, getBadgeColorClasses, getColorClass,
} from './usage/usage-colors';

/** An account's usage summary as a snapshot, once its usage was fetched (null before) */
function summaryUsage(summary: ProfileUsageSummary): ClaudeUsageSnapshot | null {
  if (!summary.lastFetchedAt || summary.fetchError || !summary.isAuthenticated) return null;
  return {
    sessionPercent: summary.sessionPercent,
    weeklyPercent: summary.weeklyPercent,
    sessionResetTimestamp: summary.sessionResetTimestamp,
    weeklyResetTimestamp: summary.weeklyResetTimestamp,
    profileId: summary.profileId,
    profileName: summary.profileName,
    profileEmail: summary.profileEmail,
    fetchedAt: new Date(summary.lastFetchedAt),
    needsReauthentication: summary.needsReauthentication,
    spendLimit: summary.spendLimit,
  };
}

/** How long the badge waits for a newly selected account's usage before showing it as unavailable */
export const USAGE_LOADING_TIMEOUT_MS = 20_000;

export function UsageIndicator() {
  const { t } = useTranslation(['common']);
  // Starts from the last snapshot, so mounting again (the sidebar opening) never blanks the store
  const [rawUsage, setUsage] = useState<ClaudeUsageSnapshot | null>(() => useUsageStore.getState().usage);
  // Shared, so the usage simulator's preview in Settings shows the same numbers without asking again
  useEffect(() => { useUsageStore.getState().setUsage(rawUsage); }, [rawUsage]);
  const [isPolledLoading, setIsLoading] = useState(true);
  const [isPolledAvailable, setIsAvailable] = useState(false);
  // Every account's usage summary, so a window whose project runs on another account than the one
  // the app polls in detail (the account in use) shows its own
  const [allProfiles, setAllProfiles] = useState<ProfileUsageSummary[]>([]);
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

  // An active API profile (Anthropic-compatible endpoint) bills per token: no usage limits to show
  const activeApiProfile = useSettingsStore((state) => state.profiles.find((p) => p.id === state.activeProfileId) ?? null);
  // Claude subscription accounts report session and weekly usage
  const hasUsageMonitoring = !activeApiProfile;

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

  useEffect(() => {
    // Listen for usage updates from main process
    // A null snapshot means the account in use changed to one whose usage isn't known yet: show
    // the loading state until it arrives instead of the previous account's numbers. Its usage may
    // never come (signed out, no subscription usage, rate limited), so stop waiting after a while
    // and show it as unavailable.
    let loadingTimer: ReturnType<typeof setTimeout> | null = null;
    const clearLoadingTimer = () => {
      if (loadingTimer) clearTimeout(loadingTimer);
      loadingTimer = null;
    };
    const unsubscribe = window.electronAPI.onUsageUpdated((snapshot: ClaudeUsageSnapshot | null) => {
      setUsage(snapshot);
      setIsAvailable(!!snapshot);
      setIsLoading(!snapshot);
      clearLoadingTimer();
      if (!snapshot) loadingTimer = setTimeout(() => setIsLoading(false), USAGE_LOADING_TIMEOUT_MS);
    });

    // Listen for all profiles usage updates (re-auth state, and the window's own account's usage)
    const unsubscribeAllProfiles = window.electronAPI.onAllProfilesUsageUpdated?.((allProfilesUsage) => {
      setAllProfiles(allProfilesUsage.allProfiles);
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

    // Request all profiles usage immediately on mount (re-auth state, even if main usage is unavailable)
    window.electronAPI.requestAllProfilesUsage?.().then((result) => {
      if (result.success && result.data) setAllProfiles(result.data.allProfiles);
    }).catch(() => {
      // Silently ignore
    });

    return () => {
      clearLoadingTimer();
      unsubscribe();
      unsubscribeAllProfiles?.();
    };
  }, []);

  // The account this window's project runs on. The detailed snapshot is the account in use's; a
  // project on another account shows that account's summary (session and weekly limits)
  const windowAccountId = useWindowClaudeAccountId();
  const globalAccountId = useClaudeProfileStore((state) => state.activeProfileId);
  const showsOwn = windowAccountId !== globalAccountId && rawUsage?.profileId !== windowAccountId;
  const ownSummary = showsOwn ? allProfiles.find((summary) => summary.profileId === windowAccountId) : undefined;
  const usage = showsOwn ? (ownSummary ? summaryUsage(ownSummary) : null) : rawUsage;
  const isAvailable = showsOwn ? !!usage : isPolledAvailable;
  const isLoading = showsOwn ? !ownSummary && allProfiles.length === 0 && isPolledLoading : isPolledLoading;
  const windowSummary = ownSummary
    ?? allProfiles.find((summary) => summary.profileId === (rawUsage?.profileId ?? windowAccountId))
    ?? allProfiles.find((summary) => summary.isActive);
  const activeProfileNeedsReauth = windowSummary?.needsReauthentication ?? false;

  // Show loading state - only for Anthropic OAuth accounts awaiting usage data (an account that
  // needs signing in again shows that instead: its usage won't arrive)
  if (isLoading && hasUsageMonitoring && !activeProfileNeedsReauth) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border bg-muted/50 text-muted-foreground">
        <Activity className="h-3.5 w-3.5 motion-safe:animate-pulse" />
        <span className="text-xs font-semibold">{t('common:usage.loading')}</span>
      </div>
    );
  }

  // API profiles (pay as you go): no usage limits to track
  if (activeApiProfile) {
    const badgeLabel = t('common:usage.apiKeyBadge');
    const badgeColor = 'text-muted-foreground bg-muted/50 border-border';

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
            <Activity className="h-3.5 w-3.5" />
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
          <ApiProfileUsageCard onManageAccounts={handleOpenAccounts} active={isOpen} />
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
          {needsReauth ? <ReauthRequiredCard onReauth={handleOpenAccounts} active={isOpen} /> : <UsageUnavailableCard active={isOpen} />}
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
          ) : usage.spendLimit ? (
            // Enterprise: the one limit there is, the share of the month's spend limit used
            <span
              className={`text-xs font-semibold font-mono leading-none tabular-nums ${getColorClass(weeklyPercent)}`}
              title={t('common:usage.spendShort')}
            >
              {Math.round(weeklyPercent)}%
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
        // The card draws its own background and border (UsageCardSurface), so the popover drops both
        className={cn(
          'text-xs w-[17rem] p-0',
          !usage.needsReauthentication && 'border-transparent bg-transparent',
        )}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Re-auth required prompt - shown when the active profile needs re-authentication */}
        {usage.needsReauthentication ? (
          <ReauthRequiredCard onReauth={handleOpenAccounts} active={isOpen} />
        ) : (
          <UsageBreakdown usage={usage} open={isOpen} />
        )}
      </PopoverContent>
    </Popover>
  );
}
