/**
 * AccountSettings - Unified account management across all AI providers
 *
 * claude.ai settings layout: one section per provider category (ProviderAccountsList),
 * followed by the automatic account switching section and the account priority
 * order (AccountPriorityList).
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { cn } from '../../lib/utils';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows, SegmentedControl } from './SettingsRow';
import { AccountPriorityList, type UnifiedAccount } from './AccountPriorityList';
import { ProviderAccountsList } from './ProviderAccountsList';
import { useSettingsStore } from '../../stores/settings-store';
import { useToast } from '../../hooks/use-toast';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';
import type { AppSettings, ClaudeAutoSwitchSettings, ProfileUsageSummary } from '../../../shared/types';

interface AccountSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  isOpen: boolean;
}

export function AccountSettings({ settings, onSettingsChange, isOpen }: AccountSettingsProps) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const { getProviderAccounts, setQueueOrder, setCrossProviderQueueOrder } = useSettingsStore();

  // Derive priority orders from Zustand store (single source of truth)
  const priorityOrder = settings.globalPriorityOrder ?? [];
  const crossProviderPriorityOrder = settings.crossProviderPriorityOrder ?? [];

  // ============================================
  // Auto-switch settings state
  // ============================================
  const [autoSwitchSettings, setAutoSwitchSettings] = useState<ClaudeAutoSwitchSettings | null>(null);
  const [isLoadingAutoSwitch, setIsLoadingAutoSwitch] = useState(false);

  // ============================================
  // Priority UI state
  // ============================================
  const [isSavingPriority, setIsSavingPriority] = useState(false);
  const [priorityTab, setPriorityTab] = useState<'default' | 'cross-provider'>('default');

  // ============================================
  // Usage data state
  // ============================================
  const [profileUsageData, setProfileUsageData] = useState<Map<string, ProfileUsageSummary>>(new Map());

  const loadProfileUsageData = useCallback(async (forceRefresh: boolean = false) => {
    try {
      const result = await window.electronAPI.requestAllProfilesUsage?.(forceRefresh);
      if (result?.success && result.data) {
        const usageMap = new Map<string, ProfileUsageSummary>();
        result.data.allProfiles.forEach(profile => {
          usageMap.set(profile.profileId, profile);
        });
        setProfileUsageData(usageMap);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  // Build unified accounts list sorted by a given priority order
  const buildUnifiedAccountsForOrder = useCallback((order: string[]): UnifiedAccount[] => {
    const allAccounts = getProviderAccounts();
    return allAccounts.map(account => {
      const usageData = (account.claudeProfileId
        ? profileUsageData.get(account.claudeProfileId)
        : undefined) ?? profileUsageData.get(account.id);
      const profileEmail = usageData?.profileEmail || account.email;

      const identifier = account.authType === 'oauth'
        ? (profileEmail || PROVIDER_REGISTRY.find(p => p.id === account.provider)?.name || t('accounts.priority.noEmail'))
        : (account.baseUrl ?? (PROVIDER_REGISTRY.find(p => p.id === account.provider)?.name ?? account.provider));

      return {
        id: account.id,
        name: account.name,
        type: account.authType === 'oauth' ? 'oauth' : 'api',
        displayName: account.name,
        identifier,
        provider: account.provider,
        profileEmail,
        isActive: order.length > 0 ? order[0] === account.id : false,
        isNext: false,
        isAvailable: true,
        hasUnlimitedUsage: account.authType === 'api-key',
        sessionPercent: usageData?.sessionPercent,
        weeklyPercent: usageData?.weeklyPercent,
        isRateLimited: usageData?.isRateLimited,
        rateLimitType: usageData?.rateLimitType,
        needsReauthentication: usageData?.needsReauthentication,
      } satisfies UnifiedAccount;
    }).sort((a, b) => {
      if (order.length === 0) return 0;
      const aPos = order.indexOf(a.id);
      const bPos = order.indexOf(b.id);
      return (aPos === -1 ? Infinity : aPos) - (bPos === -1 ? Infinity : bPos);
    });
  }, [getProviderAccounts, profileUsageData, t]);

  const unifiedAccounts = buildUnifiedAccountsForOrder(priorityOrder);
  const crossProviderUnifiedAccounts = buildUnifiedAccountsForOrder(
    crossProviderPriorityOrder.length > 0 ? crossProviderPriorityOrder : priorityOrder
  );

  const handlePriorityReorder = async (newOrder: string[]) => {
    setIsSavingPriority(true);
    try {
      await setQueueOrder(newOrder);
    } catch {
      toast({
        variant: 'destructive',
        title: t('accounts.toast.settingsUpdateFailed'),
        description: t('accounts.toast.tryAgain'),
      });
    } finally {
      setIsSavingPriority(false);
    }
  };

  const handleCrossProviderPriorityReorder = async (newOrder: string[]) => {
    setIsSavingPriority(true);
    try {
      await setCrossProviderQueueOrder(newOrder);
    } catch {
      toast({
        variant: 'destructive',
        title: t('accounts.toast.settingsUpdateFailed'),
        description: t('accounts.toast.tryAgain'),
      });
    } finally {
      setIsSavingPriority(false);
    }
  };

  const handleSetActive = useCallback(async (accountId: string) => {
    const newOrder = [accountId, ...priorityOrder.filter(id => id !== accountId)];
    setIsSavingPriority(true);
    try {
      await setQueueOrder(newOrder);
    } catch {
      toast({
        variant: 'destructive',
        title: t('accounts.toast.settingsUpdateFailed'),
        description: t('accounts.toast.tryAgain'),
      });
    } finally {
      setIsSavingPriority(false);
    }
  }, [priorityOrder, setQueueOrder, toast, t]);

  const handleCrossProviderSetActive = useCallback(async (accountId: string) => {
    const cpOrder = crossProviderPriorityOrder.length > 0 ? crossProviderPriorityOrder : priorityOrder;
    const newOrder = [accountId, ...cpOrder.filter(id => id !== accountId)];
    setIsSavingPriority(true);
    try {
      await setCrossProviderQueueOrder(newOrder);
    } catch {
      toast({
        variant: 'destructive',
        title: t('accounts.toast.settingsUpdateFailed'),
        description: t('accounts.toast.tryAgain'),
      });
    } finally {
      setIsSavingPriority(false);
    }
  }, [crossProviderPriorityOrder, priorityOrder, setCrossProviderQueueOrder, toast, t]);

  const handlePriorityTabChange = useCallback((tab: 'default' | 'cross-provider') => {
    setPriorityTab(tab);
    // Lazy-initialize cross-provider order from global order on first tab switch
    if (tab === 'cross-provider' && crossProviderPriorityOrder.length === 0 && priorityOrder.length > 0) {
      setCrossProviderQueueOrder(priorityOrder);
    }
  }, [crossProviderPriorityOrder.length, priorityOrder, setCrossProviderQueueOrder]);

  useEffect(() => {
    if (isOpen) {
      loadAutoSwitchSettings();
      loadProfileUsageData(false); // Use cached data; push-based listener below provides fresh updates
    }
  }, [isOpen, loadProfileUsageData]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onAllProfilesUsageUpdated?.((allProfilesUsage) => {
      const usageMap = new Map<string, ProfileUsageSummary>();
      allProfilesUsage.allProfiles.forEach(profile => {
        usageMap.set(profile.profileId, profile);
      });
      setProfileUsageData(usageMap);
    });
    return () => { unsubscribe?.(); };
  }, []);

  const loadAutoSwitchSettings = async () => {
    setIsLoadingAutoSwitch(true);
    try {
      const result = await window.electronAPI.getAutoSwitchSettings();
      if (result.success && result.data) {
        setAutoSwitchSettings(result.data);
      }
    } catch {
      // Non-fatal
    } finally {
      setIsLoadingAutoSwitch(false);
    }
  };

  const handleUpdateAutoSwitch = async (updates: Partial<ClaudeAutoSwitchSettings>) => {
    setIsLoadingAutoSwitch(true);
    try {
      const result = await window.electronAPI.updateAutoSwitchSettings(updates);
      if (result.success) {
        await loadAutoSwitchSettings();
      } else {
        toast({
          variant: 'destructive',
          title: t('accounts.toast.settingsUpdateFailed'),
          description: result.error || t('accounts.toast.tryAgain'),
        });
      }
    } catch {
      toast({
        variant: 'destructive',
        title: t('accounts.toast.settingsUpdateFailed'),
        description: t('accounts.toast.tryAgain'),
      });
    } finally {
      setIsLoadingAutoSwitch(false);
    }
  };

  const totalAccounts = unifiedAccounts.length;

  const thresholdSlider = (
    id: string,
    value: number,
    onChange: (value: number) => void,
    describedBy: string
  ) => (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        min="0"
        max="99"
        step="1"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        disabled={isLoadingAutoSwitch}
        aria-describedby={describedBy}
        className={cn(
          'h-1.5 w-40 cursor-pointer appearance-none rounded-full bg-segment-track disabled:cursor-default',
          'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
          '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none',
          '[&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground',
          '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer',
          '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-foreground'
        )}
      />
      <span className="w-9 text-right text-sm tabular-nums text-foreground">{value}%</span>
    </div>
  );

  return (
    <>
      {/* Provider accounts: one section per provider category */}
      <ProviderAccountsList />

      {/* Automatic account switching */}
      {totalAccounts > 1 && (
        <SettingsSection title={t('accounts.autoSwitching.title')}>
          <SettingsRows>
            <SettingsRow
              label={t('accounts.autoSwitching.enableAutoSwitching')}
              description={t('accounts.autoSwitching.description')}
            >
              <Switch
                checked={autoSwitchSettings?.enabled ?? false}
                onCheckedChange={(enabled) => handleUpdateAutoSwitch({ enabled })}
                disabled={isLoadingAutoSwitch}
                aria-label={t('accounts.autoSwitching.enableAutoSwitching')}
              />
            </SettingsRow>

            {autoSwitchSettings?.enabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.proactiveMonitoring')}
                description={t('accounts.autoSwitching.proactiveDescription')}
              >
                <Switch
                  checked={autoSwitchSettings?.proactiveSwapEnabled ?? true}
                  onCheckedChange={(value) => handleUpdateAutoSwitch({ proactiveSwapEnabled: value })}
                  disabled={isLoadingAutoSwitch}
                  aria-label={t('accounts.autoSwitching.proactiveMonitoring')}
                />
              </SettingsRow>
            )}

            {autoSwitchSettings?.enabled && autoSwitchSettings?.proactiveSwapEnabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.sessionThreshold')}
                htmlFor="session-threshold"
                description={
                  <span id="session-threshold-description">
                    {t('accounts.autoSwitching.sessionThresholdDescription')}
                  </span>
                }
              >
                {thresholdSlider(
                  'session-threshold',
                  autoSwitchSettings?.sessionThreshold ?? 95,
                  (value) => handleUpdateAutoSwitch({ sessionThreshold: value }),
                  'session-threshold-description'
                )}
              </SettingsRow>
            )}

            {autoSwitchSettings?.enabled && autoSwitchSettings?.proactiveSwapEnabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.weeklyThreshold')}
                htmlFor="weekly-threshold"
                description={
                  <span id="weekly-threshold-description">
                    {t('accounts.autoSwitching.weeklyThresholdDescription')}
                  </span>
                }
              >
                {thresholdSlider(
                  'weekly-threshold',
                  autoSwitchSettings?.weeklyThreshold ?? 99,
                  (value) => handleUpdateAutoSwitch({ weeklyThreshold: value }),
                  'weekly-threshold-description'
                )}
              </SettingsRow>
            )}

            {autoSwitchSettings?.enabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.reactiveRecovery')}
                description={t('accounts.autoSwitching.reactiveDescription')}
              >
                <Switch
                  checked={autoSwitchSettings?.autoSwitchOnRateLimit ?? false}
                  onCheckedChange={(value) => handleUpdateAutoSwitch({ autoSwitchOnRateLimit: value })}
                  disabled={isLoadingAutoSwitch}
                  aria-label={t('accounts.autoSwitching.reactiveRecovery')}
                />
              </SettingsRow>
            )}

            {autoSwitchSettings?.enabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.autoSwitchOnAuthFailure')}
                description={t('accounts.autoSwitching.autoSwitchOnAuthFailureDescription')}
              >
                <Switch
                  checked={autoSwitchSettings?.autoSwitchOnAuthFailure ?? false}
                  onCheckedChange={(value) => handleUpdateAutoSwitch({ autoSwitchOnAuthFailure: value })}
                  disabled={isLoadingAutoSwitch}
                  aria-label={t('accounts.autoSwitching.autoSwitchOnAuthFailure')}
                />
              </SettingsRow>
            )}
          </SettingsRows>
        </SettingsSection>
      )}

      {/* Account priority order */}
      {totalAccounts > 1 && autoSwitchSettings?.enabled && (
        <SettingsSection title={t('accounts.priority.title')}>
          <SettingsRows>
            <SettingsRow
              label={t('accounts.priority.modeLabel')}
              description={
                priorityTab === 'cross-provider'
                  ? t('accounts.priority.crossProviderDescription')
                  : t('accounts.priority.description')
              }
            >
              <SegmentedControl
                value={priorityTab}
                onValueChange={handlePriorityTabChange}
                ariaLabel={t('accounts.priority.modeLabel')}
                options={[
                  { value: 'default', label: t('accounts.priority.tabs.default') },
                  { value: 'cross-provider', label: t('accounts.priority.tabs.crossProvider') },
                ]}
              />
            </SettingsRow>
            <div className="pt-1">
              {priorityTab === 'cross-provider' ? (
                <AccountPriorityList
                  key="cross-provider"
                  accounts={crossProviderUnifiedAccounts}
                  onReorder={handleCrossProviderPriorityReorder}
                  onSetActive={handleCrossProviderSetActive}
                  isLoading={isSavingPriority}
                />
              ) : (
                <AccountPriorityList
                  key="default"
                  accounts={unifiedAccounts}
                  onReorder={handlePriorityReorder}
                  onSetActive={handleSetActive}
                  isLoading={isSavingPriority}
                />
              )}
            </div>
          </SettingsRows>
        </SettingsSection>
      )}
    </>
  );
}
