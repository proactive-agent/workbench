import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw, ChevronDown, Check, Star, Plus } from 'lucide-react';
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
import { useClaudeProfileStore, loadClaudeProfiles, switchTerminalToProfile } from '../stores/claude-profile-store';
import { useToast } from '../hooks/use-toast';
import { debugError } from '../../shared/utils/debug-logger';

const CLAUDE_UPGRADE_URL = 'https://claude.ai/upgrade';

export function RateLimitModal() {
  const { t } = useTranslation('common');
  const { isModalOpen, rateLimitInfo, hideRateLimitModal, clearPendingRateLimit } = useRateLimitStore();
  const { profiles, activeProfileId, isSwitching } = useClaudeProfileStore();
  const { toast } = useToast();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [autoSwitchEnabled, setAutoSwitchEnabled] = useState(false);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isAddingProfile, setIsAddingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');

  // Load profiles and auto-switch settings when modal opens
  useEffect(() => {
    if (isModalOpen) {
      loadClaudeProfiles();
      loadAutoSwitchSettings();

      // Pre-select the suggested profile if available
      if (rateLimitInfo?.suggestedProfileId) {
        setSelectedProfileId(rateLimitInfo.suggestedProfileId);
      }
    }
  }, [isModalOpen, rateLimitInfo?.suggestedProfileId]);

  // Reset selection when modal closes
  useEffect(() => {
    if (!isModalOpen) {
      setSelectedProfileId(null);
      setIsAddingProfile(false);
      setNewProfileName('');
    }
  }, [isModalOpen]);

  const loadAutoSwitchSettings = async () => {
    try {
      const result = await window.electronAPI.getAutoSwitchSettings();
      if (result.success && result.data) {
        setAutoSwitchEnabled(result.data.autoSwitchOnRateLimit);
      }
    } catch (err) {
      debugError('[RateLimitModal] Failed to load auto-switch settings:', err);
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
      debugError('[RateLimitModal] Failed to update auto-switch settings:', err);
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
        hideRateLimitModal();

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
      debugError('[RateLimitModal] Failed to add profile:', err);
      toast({
        variant: 'destructive',
        title: t('rateLimit.toast.addProfileFailed'),
        description: t('rateLimit.toast.tryAgain'),
      });
    } finally {
      setIsAddingProfile(false);
    }
  };

  const handleSwitchProfile = async () => {
    if (!selectedProfileId || !rateLimitInfo?.terminalId) return;

    const success = await switchTerminalToProfile(rateLimitInfo.terminalId, selectedProfileId);
    if (success) {
      // Clear the pending rate limit since we successfully switched
      clearPendingRateLimit();
    }
  };

  // Get profiles that are not the current rate-limited one
  const currentProfileId = rateLimitInfo?.profileId || activeProfileId;
  const availableProfiles = profiles.filter(p => p.id !== currentProfileId);
  const hasMultipleProfiles = profiles.length > 1;

  const selectedProfile = selectedProfileId
    ? profiles.find(p => p.id === selectedProfileId)
    : null;

  const currentProfile = profiles.find(p => p.id === currentProfileId);
  const suggestedProfile = rateLimitInfo?.suggestedProfileId
    ? profiles.find(p => p.id === rateLimitInfo.suggestedProfileId)
    : null;

  // Check if auto-switch already happened
  const autoSwitchHappened = rateLimitInfo?.autoSwitchEnabled && suggestedProfile;

  return (
    <Dialog open={isModalOpen} onOpenChange={(open) => !open && hideRateLimitModal()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {t('rateLimit.modalTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('rateLimit.modalDescription')}
            {currentProfile && !currentProfile.isDefault && (
              <span className="text-muted-foreground"> ({t('rateLimit.profile', { name: currentProfile.name })})</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 min-h-0 space-y-4 overflow-y-auto px-6 pt-4">
          {/* Auto-switch notification */}
          {autoSwitchHappened && (
            <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
              <p className="text-foreground">
                {t('rateLimit.autoSwitching', { name: suggestedProfile?.name })}
              </p>
              <p className="text-muted-foreground mt-0.5">
                {t('rateLimit.autoSwitchingDescription')}
              </p>
            </div>
          )}

          {/* Reset time info */}
          {rateLimitInfo?.resetTime && !autoSwitchHappened && (
            <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
              <p className="text-foreground">
                {t('rateLimit.resetsTime', { time: rateLimitInfo.resetTime })}
              </p>
              <p className="text-muted-foreground mt-0.5">
                {t('rateLimit.usageRestored')}
              </p>
            </div>
          )}

          <SettingsRows>
            {/* Profile switching / Add account section - show unless auto-switch happened */}
            {!autoSwitchHappened && hasMultipleProfiles && (
              <SettingsRow
                label={t('rateLimit.switchAccount')}
                description={
                  suggestedProfile
                    ? t('rateLimit.recommended', { name: suggestedProfile.name })
                    : t('rateLimit.otherSubscriptions')
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
                          {selectedProfileId === rateLimitInfo?.suggestedProfileId && (
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
                            {profile.id === rateLimitInfo?.suggestedProfileId && (
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
                    onClick={handleSwitchProfile}
                    disabled={!selectedProfileId || isSwitching}
                    className="gap-2 shrink-0"
                  >
                    {isSwitching ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        {t('rateLimit.switching')}
                      </>
                    ) : (
                      t('buttons.switch')
                    )}
                  </Button>
                </div>
              </SettingsRow>
            )}

            {/* Auto-switch toggle */}
            {!autoSwitchHappened && hasMultipleProfiles && availableProfiles.length > 0 && (
              <SettingsRow label={t('rateLimit.autoSwitchOnRateLimit')} htmlFor="auto-switch">
                <Switch
                  id="auto-switch"
                  checked={autoSwitchEnabled}
                  onCheckedChange={handleAutoSwitchToggle}
                  disabled={isLoadingSettings}
                />
              </SettingsRow>
            )}

            {/* Add new account */}
            {!autoSwitchHappened && (
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
                    {t('buttons.add')}
                  </Button>
                </div>
              </SettingsRow>
            )}

            {/* Upgrade prompt */}
            <SettingsRow label={t('rateLimit.upgradeTitle')} description={t('rateLimit.upgradeDescription')}>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={handleUpgrade}
                aria-label={t('accessibility.upgradeSubscriptionAriaLabel')}
              >
                {t('rateLimit.upgradeSubscription')}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">({t('accessibility.opensInNewWindow')})</span>
              </Button>
            </SettingsRow>
          </SettingsRows>
        </div>

        <DialogFooter>
          <Button size="sm" onClick={hideRateLimitModal}>
            {autoSwitchHappened ? t('buttons.continue') : hasMultipleProfiles ? t('buttons.close') : t('buttons.gotIt')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
