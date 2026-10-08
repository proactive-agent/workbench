import { useTranslation } from 'react-i18next';
import { SettingsRow } from './SettingsRow';
import type { AppSettings, GpuAcceleration } from '../../../shared/types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface DisplaySettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Display settings: log order and GPU acceleration.
 */
export function DisplaySettings({ settings, onSettingsChange }: DisplaySettingsProps) {
  const { t } = useTranslation('settings');

  // Rows only: the Appearance section lists them under the theme row
  return (
    <>
      {/* Log Order Setting */}
      <SettingsRow
        label={t('logOrder.label')}
        description={t('logOrder.description')}
        htmlFor="logOrder"
      >
        <Select
          value={settings.logOrder || 'chronological'}
          onValueChange={(value) => onSettingsChange({
            ...settings,
            logOrder: value as 'chronological' | 'reverse-chronological'
          })}
        >
          <SelectTrigger id="logOrder" className="h-8 w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60 overflow-y-auto">
            <SelectItem value="chronological">
              {t('logOrder.chronological')}
            </SelectItem>
            <SelectItem value="reverse-chronological">
              {t('logOrder.reverseChronological')}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>

      {/* GPU Acceleration Setting */}
      <SettingsRow
        label={t('gpuAcceleration.label')}
        htmlFor="gpuAcceleration"
        description={
          <>
            {t('gpuAcceleration.description')}
            <span className="mt-0.5 block text-xs">{t('gpuAcceleration.helperText')}</span>
          </>
        }
      >
        <Select
          value={settings.gpuAcceleration || 'off'}
          onValueChange={(value) => onSettingsChange({
            ...settings,
            gpuAcceleration: value as GpuAcceleration
          })}
        >
          <SelectTrigger id="gpuAcceleration" className="h-8 w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60 overflow-y-auto">
            <SelectItem value="auto">
              {t('gpuAcceleration.auto')}
            </SelectItem>
            <SelectItem value="on">
              {t('gpuAcceleration.on')}
            </SelectItem>
            <SelectItem value="off">
              {t('gpuAcceleration.off')}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
    </>
  );
}
