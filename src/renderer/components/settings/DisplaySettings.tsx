import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows, SegmentedControl, type SegmentedOption } from './SettingsRow';
import { NEUTRAL_SLIDER_CLASSES, StepperButton } from './terminal-font-settings/SettingsSlider';
import { useSettingsStore } from '../../stores/settings-store';
import { UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_DEFAULT, UI_SCALE_STEP } from '../../../shared/constants';
import type { AppSettings, GpuAcceleration } from '../../../shared/types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface DisplaySettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

// Preset scale values with translation keys
const SCALE_PRESETS = [
  { value: UI_SCALE_DEFAULT, label: '100%', descriptionKey: 'scale.default' },
  { value: 125, label: '125%', descriptionKey: 'scale.comfortable' },
  { value: 150, label: '150%', descriptionKey: 'scale.large' }
] as const;

/**
 * Display settings section for UI scale/zoom control
 * Provides preset buttons (100%, 125%, 150%) and a fine-tune slider (75-200%)
 * Changes apply immediately for live preview (like theme), saved on "Save Settings"
 */
export function DisplaySettings({ settings, onSettingsChange }: DisplaySettingsProps) {
  const { t } = useTranslation('settings');
  const updateStoreSettings = useSettingsStore((state) => state.updateSettings);

  const currentScale = settings.uiScale ?? UI_SCALE_DEFAULT;

  // Local state for pending scale changes - prevents view reload until user applies
  const [pendingScale, setPendingScale] = useState<number | null>(null);

  // Track the last scale that was committed to the store (triggers view reload)
  // This is different from currentScale which updates on every onSettingsChange call
  const [committedScale, setCommittedScale] = useState<number>(currentScale);

  // Display value: use pending scale if set, otherwise use current applied scale
  const displayScale = pendingScale ?? currentScale;

  // Check if there are pending changes to apply
  // Compare against committedScale (store-applied value), not currentScale (display value)
  const hasPendingChanges = pendingScale !== null && pendingScale !== committedScale;

  // Update pending scale (for slider and +/- buttons) - doesn't trigger view reload
  const updatePendingScale = (newScale: number) => {
    const clampedScale = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, newScale));
    setPendingScale(clampedScale);
    // Update settings for display but don't trigger store update (no view reload)
    onSettingsChange({ ...settings, uiScale: clampedScale });
  };

  // Apply pending changes to store (triggers view reload)
  const handleApplyChanges = () => {
    if (pendingScale !== null) {
      updateStoreSettings({ uiScale: pendingScale });
      setCommittedScale(pendingScale);
      setPendingScale(null);
    }
  };

  // Handle preset button clicks - apply immediately (presets are intentional selections)
  const handlePresetChange = (newScale: number) => {
    const clampedScale = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, newScale));
    onSettingsChange({ ...settings, uiScale: clampedScale });
    updateStoreSettings({ uiScale: clampedScale });
    setCommittedScale(clampedScale);
    setPendingScale(null);
  };

  // Handle slider drag - only update pending state
  const handleSliderChange = (newScale: number) => {
    if (Number.isNaN(newScale)) return;
    updatePendingScale(newScale);
  };

  // Handle zoom button clicks - increment/decrement by step (updates pending state)
  const handleZoomOut = () => {
    updatePendingScale(displayScale - UI_SCALE_STEP);
  };

  const handleZoomIn = () => {
    updatePendingScale(displayScale + UI_SCALE_STEP);
  };

  const handleReset = () => {
    handlePresetChange(UI_SCALE_DEFAULT);
  };

  const presetOptions: SegmentedOption<string>[] = SCALE_PRESETS.map((preset) => ({
    value: String(preset.value),
    label: preset.label
  }));

  return (
    <SettingsSection
      title={t('sections.display.title')}
      description={t('sections.display.description')}
    >
      <SettingsRows>
        {/* Preset Buttons */}
        <SettingsRow label={t('scale.presets')} description={t('scale.presetsDescription')}>
          <SegmentedControl
            value={String(currentScale)}
            options={presetOptions}
            onValueChange={(value) => handlePresetChange(Number(value))}
            ariaLabel={t('scale.presets')}
          />
        </SettingsRow>

        {/* Fine-tune Slider */}
        <SettingsRow label={t('scale.fineTune')} description={t('scale.fineTuneDescription')}>
          <input
            type="range"
            min={UI_SCALE_MIN}
            max={UI_SCALE_MAX}
            step={UI_SCALE_STEP}
            value={displayScale}
            aria-label={t('scale.fineTune')}
            onChange={(e) => handleSliderChange(parseInt(e.target.value, 10))}
            className={cn(NEUTRAL_SLIDER_CLASSES, 'w-40')}
          />
          <div className="flex items-center gap-0.5">
            <StepperButton
              direction="decrease"
              onClick={handleZoomOut}
              disabled={displayScale <= UI_SCALE_MIN}
              title={t('scale.decrease')}
            />
            <span className="w-12 text-center font-mono text-sm text-foreground">{displayScale}%</span>
            <StepperButton
              direction="increase"
              onClick={handleZoomIn}
              disabled={displayScale >= UI_SCALE_MAX}
              title={t('scale.increase')}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleReset}
            disabled={displayScale === UI_SCALE_DEFAULT}
            title={t('scale.reset')}
            aria-label={t('scale.reset')}
            className="w-8 px-0"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleApplyChanges}
            disabled={!hasPendingChanges}
            title={t('scale.applyTitle')}
          >
            {t('scale.apply')}
          </Button>
        </SettingsRow>

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
      </SettingsRows>
    </SettingsSection>
  );
}
