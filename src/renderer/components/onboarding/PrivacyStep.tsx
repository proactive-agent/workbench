import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { SettingsRow } from '../settings/SettingsRow';
import { useSettingsStore } from '../../stores/settings-store';
import { notifySentryStateChanged } from '../../lib/sentry';

interface PrivacyStepProps {
  onNext: () => void;
  onBack: () => void;
}

/**
 * Onboarding step for anonymous error reporting opt-in.
 * Explains what data is collected and what is never collected.
 * Enabled by default to help improve the app.
 */
export function PrivacyStep({ onNext, onBack }: PrivacyStepProps) {
  const { t } = useTranslation(['onboarding', 'common']);
  const { settings, updateSettings } = useSettingsStore();
  const [sentryEnabled, setSentryEnabled] = useState(settings.sentryEnabled ?? true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = (checked: boolean) => {
    setSentryEnabled(checked);
    setError(null); // Clear error when user interacts
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const result = await window.electronAPI.saveSettings({ sentryEnabled });
      if (result?.success) {
        updateSettings({ sentryEnabled });
        notifySentryStateChanged(sentryEnabled);
        onNext();
      } else {
        setError(t('onboarding:privacy.saveFailed', 'Failed to save privacy settings. Please try again.'));
      }
    } catch (_err) {
      setError(t('onboarding:privacy.saveFailed', 'Failed to save privacy settings. Please try again.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-6">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">
            {t('onboarding:privacy.title')}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t('onboarding:privacy.subtitle')}
          </p>
        </div>

        <div className="space-y-4">
          {/* What we collect */}
          <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
            <p className="text-foreground mb-2">
              {t('onboarding:privacy.whatWeCollect.title')}
            </p>
            <ul className="text-muted-foreground space-y-1 list-disc list-inside">
              <li>{t('onboarding:privacy.whatWeCollect.crashReports')}</li>
              <li>{t('onboarding:privacy.whatWeCollect.errorMessages')}</li>
              <li>{t('onboarding:privacy.whatWeCollect.appVersion')}</li>
            </ul>
          </div>

          {/* What we never collect */}
          <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
            <p className="text-foreground mb-2">
              {t('onboarding:privacy.whatWeNeverCollect.title')}
            </p>
            <ul className="text-muted-foreground space-y-1 list-disc list-inside">
              <li>{t('onboarding:privacy.whatWeNeverCollect.code')}</li>
              <li>{t('onboarding:privacy.whatWeNeverCollect.filenames')}</li>
              <li>{t('onboarding:privacy.whatWeNeverCollect.apiKeys')}</li>
              <li>{t('onboarding:privacy.whatWeNeverCollect.personalData')}</li>
            </ul>
          </div>

          {/* Toggle */}
          <SettingsRow
            label={t('onboarding:privacy.toggle.label')}
            description={t('onboarding:privacy.toggle.description')}
            htmlFor="sentry-toggle"
          >
            <Switch
              id="sentry-toggle"
              checked={sentryEnabled}
              onCheckedChange={handleToggle}
            />
          </SettingsRow>
        </div>

        {/* Error Display */}
        {error && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {/* Action Buttons */}
        <div className="flex justify-between items-center mt-10 pt-6 border-t border-settings-divider">
          <Button variant="ghost" size="sm" onClick={onBack}>
            {t('common:back', 'Back')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving ? t('common:saving', 'Saving...') : t('common:continue', 'Continue')}
          </Button>
        </div>
      </div>
    </div>
  );
}
