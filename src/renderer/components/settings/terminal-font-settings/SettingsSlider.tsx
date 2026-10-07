import { Minus, Plus } from 'lucide-react';
import { cn } from '../../../lib/utils';

/**
 * Neutral range-input styling for the settings dialog: a thin translucent track with a
 * foreground-colored round thumb (no accent colors).
 */
export const NEUTRAL_SLIDER_CLASSES = cn(
  'h-1 cursor-pointer appearance-none rounded-full bg-fill-control',
  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
  'disabled:cursor-not-allowed disabled:opacity-50',
  // Webkit (Chrome, Safari, Edge)
  '[&::-webkit-slider-thumb]:h-3.5',
  '[&::-webkit-slider-thumb]:w-3.5',
  '[&::-webkit-slider-thumb]:cursor-pointer',
  '[&::-webkit-slider-thumb]:appearance-none',
  '[&::-webkit-slider-thumb]:rounded-full',
  '[&::-webkit-slider-thumb]:bg-foreground',
  // Firefox
  '[&::-moz-range-thumb]:h-3.5',
  '[&::-moz-range-thumb]:w-3.5',
  '[&::-moz-range-thumb]:cursor-pointer',
  '[&::-moz-range-thumb]:rounded-full',
  '[&::-moz-range-thumb]:border-0',
  '[&::-moz-range-thumb]:bg-foreground'
);

/** Small ghost icon button used for -/+ steppers in settings rows */
export const STEPPER_BUTTON_CLASSES = cn(
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
  'text-muted-foreground hover:bg-nav-hover hover:text-foreground',
  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'
);

interface StepperButtonProps {
  direction: 'decrease' | 'increase';
  onClick: () => void;
  disabled?: boolean;
  title: string;
}

export function StepperButton({ direction, onClick, disabled, title }: StepperButtonProps) {
  const Icon = direction === 'decrease' ? Minus : Plus;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={STEPPER_BUTTON_CLASSES}
      title={title}
      aria-label={title}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
    </button>
  );
}

interface SettingsSliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  ariaValueText?: string;
  /** Formatted value shown next to the slider */
  valueLabel: string;
  minLabel?: string;
  maxLabel?: string;
  /** Optional -/+ stepper buttons around the value */
  onDecrease?: () => void;
  onIncrease?: () => void;
  decreaseTitle?: string;
  increaseTitle?: string;
  parse?: (raw: string) => number;
  className?: string;
}

/**
 * A compact slider for a settings row's control slot:
 * `min ──●── max   [−] value [+]`
 */
export function SettingsSlider({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  ariaValueText,
  valueLabel,
  minLabel,
  maxLabel,
  onDecrease,
  onIncrease,
  decreaseTitle,
  increaseTitle,
  parse = (raw) => parseFloat(raw),
  className
}: SettingsSliderProps) {
  const hasStepper = !!onDecrease && !!onIncrease;
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {minLabel && (
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{minLabel}</span>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parse(e.target.value))}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={ariaValueText}
        className={cn(NEUTRAL_SLIDER_CLASSES, 'w-40')}
      />
      {maxLabel && (
        <span className="w-9 shrink-0 text-xs tabular-nums text-muted-foreground">{maxLabel}</span>
      )}
      <div className="flex items-center gap-0.5">
        {hasStepper && (
          <StepperButton
            direction="decrease"
            onClick={onDecrease}
            disabled={value <= min}
            title={decreaseTitle ?? ''}
          />
        )}
        <span className="w-12 text-center font-mono text-sm text-foreground">{valueLabel}</span>
        {hasStepper && (
          <StepperButton
            direction="increase"
            onClick={onIncrease}
            disabled={value >= max}
            title={increaseTitle ?? ''}
          />
        )}
      </div>
    </div>
  );
}
