/**
 * Details of an account found in Claude Code's configuration: its name (editable) and the
 * current values of its setup (provider, config dir, sign-in, settings and variables with the
 * file they come from). Deleting an account is in its row (ClaudeAccountsSection).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SettingsRow, SettingsRows } from './SettingsRow';
import type { ClaudeProfile } from '../../../shared/types';

interface DetectedAccountDialogProps {
  open: boolean;
  profile?: ClaudeProfile;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function DetectedAccountDialog({ open, profile, onOpenChange, onSaved }: DetectedAccountDialogProps) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(profile?.name ?? '');
      setError(null);
    }
  }, [open, profile?.name]);

  const detected = profile?.detected;
  if (!profile || !detected) return null;

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile.name) {
      onOpenChange(false);
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const result = await window.electronAPI.renameClaudeProfile(profile.id, trimmed);
      if (!result.success) {
        setError(result.error || t('claudeAccounts.toast.renameFailed'));
        return;
      }
      onSaved();
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !isSaving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{profile.name}</DialogTitle>
          <DialogDescription>{t('claudeAccounts.detected.description')}</DialogDescription>
        </DialogHeader>

        <div className="-mx-6 mt-2 max-h-[60vh] min-h-0 overflow-y-auto px-6">
          <SettingsRows>
            <SettingsRow stacked htmlFor="detected-account-name" label={t('claudeAccounts.dialog.name')}>
              <Input
                id="detected-account-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                }}
                disabled={isSaving}
              />
            </SettingsRow>
            <SettingsRow label={t('claudeAccounts.detected.provider')}>
              <span className="text-sm text-foreground">{t(`claudeAccounts.providers.${detected.provider}`)}</span>
            </SettingsRow>
            {/* Where the account's credentials are defined */}
            <SettingsRow label={t('claudeAccounts.detected.profile')}>
              <span className="break-all text-right font-mono text-xs text-(--nav-label-color)">
                {detected.credentials === 'environment'
                  ? t('claudeAccounts.detected.fromEnvironment')
                  : detected.credentials ?? profile.configDir}
              </span>
            </SettingsRow>
            {detected.values.map((value) => (
              <SettingsRow
                key={value.key}
                label={<span className="font-mono text-xs">{value.key}</span>}
                description={value.source === 'environment' ? t('claudeAccounts.detected.fromEnvironment') : value.source}
              >
                <span className="max-w-64 break-all text-right font-mono text-xs text-foreground">{value.value}</span>
              </SettingsRow>
            ))}
          </SettingsRows>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('claudeAccounts.dialog.cancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={isSaving || !name.trim()}>
            {isSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('claudeAccounts.dialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
