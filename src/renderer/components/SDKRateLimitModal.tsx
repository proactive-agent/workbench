import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ChevronDown, Check, Star, Plus } from 'lucide-react';
import { ExternalLink } from './ui/external-link';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Switch } from './ui/switch';
import { SettingsRow, SettingsRows } from './settings/SettingsRow';
import { Input } from './ui/input';
import { useRateLimitStore } from '../stores/rate-limit-store';
import { useClaudeProfileStore, loadClaudeProfiles } from '../stores/claude-profile-store';
import { useToast } from '../hooks/use-toast';
import { debugError } from '../../shared/utils/debug-logger';
import type { SDKRateLimitInfo } from '../../shared/types';

const CLAUDE_UPGRADE_URL = 'https://claude.ai/upgrade';

/**
 * Get a human-readable name for the source
 */
function getSourceName(source: SDKRateLimitInfo['source'], t: (key: string) => string): string {
  switch (source) {
    case 'task': return t('rateLimit.sdk.sourceNames.task');
    case 'title-generator': return t('rateLimit.sdk.sourceNames.titleGenerator');
    default: return t('rateLimit.sdk.sourceNames.other');
  }
}

export function SDKRateLimitModal() {
  const { isSDKModalOpen, sdkRateLimitInfo, hideSDKRateLimitModal, clearPendingRateLimit } = useRateLimitStore();
  const { profiles, isSwitching, setSwitching } = useClaudeProfileStore();
  const { toast } = useToast();
  const { t } = useTranslation('common');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [autoSwitchEnabled, setAutoSwitchEnabled] = useState(false);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isAddingProfile, setIsAddingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [swapInfo, setSwapInfo] = useState<{
    wasAutoSwapped: boolean;
    swapReason?: 'proactive' | 'reactive';
    swappedFrom?: string;
    swappedTo?: string;
  } | null>(null);

  // Load profiles and auto-switch settings when modal opens
  useEffect(() => {
    if (isSDKModalOpen) {
      loadClaudeProfiles();
      loadAutoSwitchSettings();

      // Pre-select the suggested profile if available
      if (sdkRateLimitInfo?.suggestedProfile?.id) {
        setSelectedProfileId(sdkRateLimitInfo.suggestedProfile.id);
      }

      // Set swap info if auto-swap occurred
      if (sdkRateLimitInfo) {
        setSwapInfo({
          wasAutoSwapped: sdkRateLimitInfo.wasAutoSwapped ?? false,
          swapReason: sdkRateLimitInfo.swapReason,
          swappedFrom: profiles.find(p => p.id === sdkRateLimitInfo.profileId)?.name,
          swappedTo: sdkRateLimitInfo.swappedToProfile?.name
        });
      }
    }
  }, [isSDKModalOpen, sdkRateLimitInfo, profiles]);

  // Reset selection when modal closes
  useEffect(() => {
    if (!isSDKModalOpen) {
      setSelectedProfileId(null);
      setIsRetrying(false);
      setIsAddingProfile(false);
      setNewProfileName('');
    }
  }, [isSDKModalOpen]);

  const loadAutoSwitchSettings = async () => {
    try {
      const result = await window.electronAPI.getAutoSwitchSettings();
      if (result.success && result.data) {
        setAutoSwitchEnabled(result.data.autoSwitchOnRateLimit);
      }
    } catch (err) {
      debugError('[SDKRateLimitModal] Failed to load auto-switch settings:', err);
    }
  };

  const handleAutoSwitchToggle = async (enabled: boolean) => {
    setIsLoadingSettings(true);
    try {
      await window.electronAPI.updateAutoSwitchSettings({
        enabled: enabled,
        autoSwitchOnRateLimit: enabled
      });
      setAutoSwitchEnabled(enabled);
    } catch (err) {
      debugError('[SDKRateLimitModal] Failed to update auto-switch settings:', err);
    } finally {
      setIsLoadingSettings(false);
    }
  };

  const handleUpgrade = () => {
    window.open(CLAUDE_UPGRADE_URL, '_blank');
  };

  const handleAddProfile = async () => {
    if (!newProfileName.trim()) return;

    setIsAddingProfile(true);
    try {
      // Create a new profile - the backend will set the proper configDir
      const profileName = newProfileName.trim();
      const profileSlug = profileName.toLowerCase().replace(/\s+/g, '-');

      const result = await window.electronAPI.saveClaudeProfile({
        id: `profile-${Date.now()}`,
        name: profileName,
        // Use a placeholder - the backend will resolve the actual path
        configDir: `~/.claude-profiles/${profileSlug}`,
        isDefault: false,
        createdAt: new Date()
      });

      if (result.success && result.data) {
        // Reload profiles
        loadClaudeProfiles();
        setNewProfileName('');
        // Close the modal
        hideSDKRateLimitModal();

        // Direct user to Settings to complete authentication
        alert(
          `${t('profileCreated.title', { profileName })}\n\n` +
          `${t('profileCreated.instructions')}\n` +
          `1. ${t('profileCreated.step1')}\n` +
          `2. ${t('profileCreated.step2')}\n` +
          `3. ${t('profileCreated.step3')}\n\n` +
          `${t('profileCreated.footer')}`
        );
      }
    } catch (err) {
      debugError('[SDKRateLimitModal] Failed to add profile:', err);
      toast({
        variant: 'destructive',
        title: t('rateLimit.toast.addProfileFailed'),
        description: t('rateLimit.toast.tryAgain'),
      });
    } finally {
      setIsAddingProfile(false);
    }
  };

  const handleRetryWithProfile = async () => {
    if (!selectedProfileId || !sdkRateLimitInfo?.projectId) return;

    setIsRetrying(true);
    setSwitching(true);

    try {
      // First, set the active profile
      await window.electronAPI.setActiveClaudeProfile(selectedProfileId);

      // Then retry the operation
      const result = await window.electronAPI.retryWithProfile({
        source: sdkRateLimitInfo.source,
        projectId: sdkRateLimitInfo.projectId,
        taskId: sdkRateLimitInfo.taskId,
        profileId: selectedProfileId
      });

      if (result.success) {
        // Clear the pending rate limit since we successfully switched
        clearPendingRateLimit();
      }
    } catch (err) {
      debugError('[SDKRateLimitModal] Failed to retry with profile:', err);
    } finally {
      setIsRetrying(false);
      setSwitching(false);
    }
  };

  if (!sdkRateLimitInfo) return null;

  // Get profiles that are not the current rate-limited one
  const currentProfileId = sdkRateLimitInfo.profileId;
  const availableProfiles = profiles.filter(p => p.id !== currentProfileId);
  const hasMultipleProfiles = profiles.length > 1;

  const selectedProfile = selectedProfileId
    ? profiles.find(p => p.id === selectedProfileId)
    : null;

  const currentProfile = profiles.find(p => p.id === currentProfileId);
  const suggestedProfile = sdkRateLimitInfo.suggestedProfile
    ? profiles.find(p => p.id === sdkRateLimitInfo.suggestedProfile?.id)
    : null;

  const sourceName = getSourceName(sdkRateLimitInfo.source, t);

  return (
    <Dialog open={isSDKModalOpen} onOpenChange={(open) => !open && hideSDKRateLimitModal()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {t('rateLimit.sdk.title')}
          </DialogTitle>
          <DialogDescription>
            {t('rateLimit.sdk.interrupted', { source: sourceName })}
            {currentProfile && (
              <span className="text-muted-foreground"> ({t('rateLimit.profile', { name: currentProfile.name })})</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 min-h-0 space-y-4 overflow-y-auto px-6 pt-4">
          {/* Swap notification info */}
          <div className="rounded-xl bg-segment-track px-4 py-3 text-sm text-muted-foreground">
            {swapInfo?.wasAutoSwapped ? (
              <>
                <p className="text-foreground mb-1">
                  {swapInfo.swapReason === 'proactive' ? t('rateLimit.sdk.proactiveSwap') : t('rateLimit.sdk.reactiveSwap')}
                </p>
                <p>
                  {swapInfo.swapReason === 'proactive'
                    ? t('rateLimit.sdk.proactiveSwapDesc', { from: swapInfo.swappedFrom, to: swapInfo.swappedTo })
                    : t('rateLimit.sdk.reactiveSwapDesc', { from: swapInfo.swappedFrom, to: swapInfo.swappedTo })
                  }
                </p>
                <p className="mt-2">
                  {t('rateLimit.sdk.continueWithoutInterruption')}
                </p>
              </>
            ) : (
              <>
                <p className="text-foreground mb-1">{t('rateLimit.sdk.rateLimitReached')}</p>
                <p>
                  {t('rateLimit.sdk.operationStopped', { account: currentProfile?.name || t('rateLimit.sdk.yourAccount') })}
                  {hasMultipleProfiles
                    ? ' ' + t('rateLimit.sdk.switchBelow')
                    : ' ' + t('rateLimit.sdk.addAccountToContinue')}
                </p>
              </>
            )}
          </div>

          <SettingsRows>
            {/* Reset time info */}
            {sdkRateLimitInfo.resetTime && (
              <SettingsRow
                label={t('rateLimit.sdk.resetsLabel', { time: sdkRateLimitInfo.resetTime })}
                description={
                  sdkRateLimitInfo.limitType === 'weekly'
                    ? t('rateLimit.sdk.weeklyLimit')
                    : t('rateLimit.sdk.sessionLimit')
                }
              />
            )}

            {/* Profile switching */}
            {hasMultipleProfiles && (
              <SettingsRow
                label={t('rateLimit.sdk.switchAccountRetry')}
                description={
                  suggestedProfile
                    ? t('rateLimit.recommended', { name: suggestedProfile.name })
                    : t('rateLimit.sdk.switchAndRetry')
                }
                stacked
                footer={
                  selectedProfile?.description ? (
                    <p className="text-sm text-(--nav-label-color)">{selectedProfile.description}</p>
                  ) : undefined
                }
              >
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="flex-1 justify-between">
                        <span className="truncate flex items-center gap-2">
                          {selectedProfile?.name || t('rateLimit.selectAccount')}
                          {selectedProfileId === sdkRateLimitInfo.suggestedProfile?.id && (
                            <Star className="h-3 w-3 text-muted-foreground" />
                          )}
                        </span>
                        <ChevronDown className="h-4 w-4 shrink-0 ml-2" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-[220px]">
                      {availableProfiles.map((profile) => (
                        <DropdownMenuItem
                          key={profile.id}
                          onClick={() => setSelectedProfileId(profile.id)}
                          className="flex items-center justify-between"
                        >
                          <span className="truncate flex items-center gap-2">
                            {profile.name}
                            {profile.id === sdkRateLimitInfo.suggestedProfile?.id && (
                              <Star className="h-3 w-3 text-muted-foreground" aria-label={t('rateLimit.recommendedLabel')} />
                            )}
                          </span>
                          {selectedProfileId === profile.id && (
                            <Check className="h-4 w-4 shrink-0" />
                          )}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => {
                          // Focus the add account input
                          const input = document.querySelector('input[placeholder*="Account name"]') as HTMLInputElement;
                          if (input) input.focus();
                        }}
                        className="flex items-center gap-2 text-muted-foreground"
                      >
                        <Plus className="h-4 w-4" />
                        {t('rateLimit.addNewAccount')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleRetryWithProfile}
                    disabled={!selectedProfileId || isRetrying || isSwitching}
                    className="gap-2 shrink-0"
                  >
                    {isRetrying || isSwitching ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        {t('rateLimit.sdk.retrying')}
                      </>
                    ) : (
                      t('rateLimit.sdk.retry')
                    )}
                  </Button>
                </div>
              </SettingsRow>
            )}

            {/* Auto-switch toggle */}
            {hasMultipleProfiles && availableProfiles.length > 0 && (
              <SettingsRow label={t('rateLimit.sdk.autoSwitchRetryLabel')} htmlFor="sdk-auto-switch">
                <Switch
                  id="sdk-auto-switch"
                  checked={autoSwitchEnabled}
                  onCheckedChange={handleAutoSwitchToggle}
                  disabled={isLoadingSettings}
                />
              </SettingsRow>
            )}

            {/* Add new account */}
            <SettingsRow
              label={hasMultipleProfiles ? t('rateLimit.addAnotherAccount') : t('rateLimit.useAnotherAccount')}
              description={
                hasMultipleProfiles
                  ? t('rateLimit.willOpenLogin')
                  : `${t('rateLimit.addAnotherSubscription')} ${t('rateLimit.willOpenLogin')}`
              }
              stacked
            >
              <div className="flex items-center gap-2">
                <Input
                  placeholder={t('rateLimit.accountNamePlaceholder')}
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  className="flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newProfileName.trim()) {
                      handleAddProfile();
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddProfile}
                  disabled={!newProfileName.trim() || isAddingProfile}
                  className="gap-1 shrink-0"
                >
                  {isAddingProfile && <RefreshCw className="h-3 w-3 animate-spin" />}
                  {t('rateLimit.sdk.add')}
                </Button>
              </div>
            </SettingsRow>

            {/* Upgrade prompt */}
            <SettingsRow label={t('rateLimit.upgradeTitle')} description={t('rateLimit.upgradeDescription')}>
              <ExternalLink onClick={handleUpgrade}>{t('rateLimit.upgradeSubscription')}</ExternalLink>
            </SettingsRow>
          </SettingsRows>

          {/* Info about what was interrupted */}
          <div className="rounded-xl bg-segment-track px-4 py-3 text-sm text-muted-foreground">
            <p className="text-foreground mb-1">{t('rateLimit.sdk.whatHappened')}</p>
            <p>
              {t('rateLimit.sdk.whatHappenedDesc', { source: sourceName.toLowerCase(), account: currentProfile?.name || t('rateLimit.sdk.defaultAccount') })}
              {hasMultipleProfiles
                ? ' ' + t('rateLimit.sdk.switchRetryOrAdd')
                : ' ' + t('rateLimit.sdk.addOrWait')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => window.open(CLAUDE_UPGRADE_URL, '_blank')}>
            {t('rateLimit.sdk.upgradeToProButton')}
          </Button>
          <Button size="sm" onClick={hideSDKRateLimitModal}>
            {t('rateLimit.sdk.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
