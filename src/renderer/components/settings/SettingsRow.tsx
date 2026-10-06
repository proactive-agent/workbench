import { cn } from '../../lib/utils';

interface SettingsRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** id of the control, links the label to it */
  htmlFor?: string;
  /** The control (switch, select, segmented control, button...) */
  children?: React.ReactNode;
  /** Render the control below the label instead of right-aligned (for wide inputs) */
  stacked?: boolean;
  /** Extra content rendered under the row (helper text, custom path inputs, ...) */
  footer?: React.ReactNode;
  className?: string;
}

/**
 * A single settings row: label + optional description on the left,
 * control right-aligned on the same line.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  children,
  stacked = false,
  footer,
  className
}: SettingsRowProps) {
  const labelNode = htmlFor ? (
    <label htmlFor={htmlFor} className="block text-sm font-normal text-foreground">
      {label}
    </label>
  ) : (
    <div className="text-sm font-normal text-foreground">{label}</div>
  );

  return (
    <div className={cn('py-4', className)}>
      <div
        className={cn(
          stacked ? 'flex flex-col gap-3' : 'flex items-center justify-between gap-6'
        )}
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          {labelNode}
          {description && (
            <div className="text-sm text-muted-foreground">{description}</div>
          )}
        </div>
        {children !== undefined && children !== null && (
          <div className={cn(stacked ? 'w-full' : 'flex shrink-0 items-center gap-2')}>
            {children}
          </div>
        )}
      </div>
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  );
}

interface SettingsRowsProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Container that separates rows with hairline dividers.
 */
export function SettingsRows({ children, className }: SettingsRowsProps) {
  return (
    <div className={cn('divide-y divide-border', className)}>
      {children}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ElementType;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onValueChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}

/**
 * Compact pill-group selector for small enums (e.g. System / Light / Dark).
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  className
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center rounded-lg bg-segment p-0.5', className)}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors duration-150',
              'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
              isSelected
                ? 'border-border bg-segment-active text-foreground shadow-sm'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {Icon && <Icon className="h-4 w-4" strokeWidth={1.75} />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
