import { useTranslation } from 'react-i18next';
import type { BuiltinProvider } from '@shared/types/provider-account';
import {
  getReasoningConfigForModel,
  REASONING_TYPE_BADGES,
  THINKING_LEVELS,
} from '@shared/constants/models';
import type { ReasoningType } from '@shared/constants/models';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';

interface ThinkingLevelSelectProps {
  value: string;
  onChange: (value: string) => void;
  modelValue: string;
  provider: BuiltinProvider;
  disabled?: boolean;
  /**
   * Compact settings-row mode: renders only the dropdown (no "Thinking level" label or badge),
   * so it can sit next to the model select in a SettingsRow control slot. Use
   * `ReasoningTypeHint` to show the reasoning type as muted text instead of a badge.
   */
  inline?: boolean;
}

interface ReasoningTypeHintProps {
  modelValue: string;
  provider: BuiltinProvider;
  /** Prefix with " · " so it can be appended to a row description */
  withSeparator?: boolean;
}

/**
 * The model's reasoning type ("Adaptive", "Budget", ...) as plain muted text with an
 * explanatory tooltip. Renders nothing for models without extended thinking.
 */
export function ReasoningTypeHint({ modelValue, provider, withSeparator = false }: ReasoningTypeHintProps) {
  const { t } = useTranslation('settings');
  const reasoningType = getReasoningConfigForModel(modelValue, provider).type;
  const badgeConfig = REASONING_TYPE_BADGES[reasoningType];
  if (!badgeConfig) return null;

  return (
    <>
      {withSeparator && ' · '}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help">
            {t(`agentProfile.reasoning.hint.${reasoningType}` as Parameters<typeof t>[0])}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs">
            {t(`agentProfile.reasoning.badgeTooltip.${reasoningType}` as Parameters<typeof t>[0])}
          </p>
        </TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * Provider-aware thinking level selector.
 * Renders different controls based on the model's reasoning type:
 *   - 'none': disabled select showing "(No thinking)"
 *   - 'thinking_toggle': On/Off toggle appearance via Select (low = Off, high = On)
 *   - all others: standard Low / Medium / High dropdown
 */
export function ThinkingLevelSelect({
  value,
  onChange,
  modelValue,
  provider,
  disabled,
  inline = false,
}: ThinkingLevelSelectProps) {
  const { t } = useTranslation('settings');

  const config = getReasoningConfigForModel(modelValue, provider);
  const reasoningType: ReasoningType = config.type;

  const badgeConfig = REASONING_TYPE_BADGES[reasoningType];

  // Render the badge with a tooltip when the reasoning type warrants one
  const renderBadge = () => {
    if (!badgeConfig) return null;
    const badgeLabel = t(badgeConfig.i18nKey as Parameters<typeof t>[0]);
    const tooltipText = t(
      `agentProfile.reasoning.badgeTooltip.${reasoningType}` as Parameters<typeof t>[0],
    );
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex cursor-help items-center rounded',
              'bg-primary/10 px-1.5 py-0.5',
              'text-[9px] font-medium text-primary',
            )}
          >
            {badgeLabel}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs">{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    );
  };

  // Label + badge above the dropdown (default), or just the dropdown (inline settings rows)
  const wrap = (select: React.ReactNode) =>
    inline ? (
      select
    ) : (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {t('agentProfile.thinkingLevel')}
          </span>
          {renderBadge()}
        </div>
        {select}
      </div>
    );
  const triggerClassName = inline ? 'h-8 w-auto' : 'h-9';
  const ariaLabel = t('agentProfile.thinkingLevel');

  // ── No thinking available ─────────────────────────────────────────────────
  if (reasoningType === 'none') {
    return wrap(
      <Select value={value} onValueChange={onChange} disabled>
        <SelectTrigger className={triggerClassName} aria-label={ariaLabel}>
          <SelectValue placeholder={t('agentProfile.reasoning.noThinking')} />
        </SelectTrigger>
        <SelectContent align={inline ? 'end' : undefined}>
          <SelectItem value={value || 'low'}>
            {t('agentProfile.reasoning.noThinking')}
          </SelectItem>
        </SelectContent>
      </Select>
    );
  }

  // ── Toggle style (Google Gemini thinking on/off) ──────────────────────────
  if (reasoningType === 'thinking_toggle') {
    const isOn = value === 'high';
    return wrap(
      <Select
        value={isOn ? 'high' : 'low'}
        onValueChange={onChange}
        disabled={disabled}
      >
        <SelectTrigger className={triggerClassName} aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align={inline ? 'end' : undefined}>
          <SelectItem value="low">
            {t('agentProfile.reasoning.toggle.off')}
          </SelectItem>
          <SelectItem value="high">
            {t('agentProfile.reasoning.toggle.on')}
          </SelectItem>
        </SelectContent>
      </Select>
    );
  }

  // ── Standard Low / Medium / High / Extra High dropdown ───────────────────
  // Only show 'xhigh' (Extra High) for reasoning_effort models (OpenAI, xAI)
  const levels = reasoningType === 'reasoning_effort'
    ? THINKING_LEVELS
    : THINKING_LEVELS.filter((l) => l.value !== 'xhigh');

  return wrap(
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={triggerClassName} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align={inline ? 'end' : undefined}>
        {levels.map((level) => (
          <SelectItem key={level.value} value={level.value}>
            {level.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
