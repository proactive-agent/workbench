import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/** Borderless dropdown trigger for a settings row's value (text + chevron), like the select triggers */
export const SETTINGS_MENU_TRIGGER_CLASS =
  'flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm text-foreground outline-none hover:bg-nav-hover focus-visible:shadow-(--shadow-focus) data-[state=open]:bg-nav-hover';

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
 * A single settings row (claude.ai): 14px title with an optional muted description on the
 * left, the control right-aligned on the same line; 12px vertical padding, 28px gap.
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
    <label htmlFor={htmlFor} className="block text-sm text-foreground">
      {label}
    </label>
  ) : (
    <div className="text-sm text-foreground">{label}</div>
  );

  return (
    <div className={cn('py-3', className)}>
      <div className={cn(stacked ? 'flex flex-col gap-3' : 'flex items-center justify-between gap-7')}>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          {labelNode}
          {description && <div className="text-sm text-(--nav-label-color)">{description}</div>}
        </div>
        {children !== undefined && children !== null && (
          <div
            data-settings-control={stacked ? undefined : ''}
            className={cn(stacked ? 'w-full' : 'flex shrink-0 items-center gap-2')}
          >
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
 * Container that separates rows with faint hairline dividers.
 */
export function SettingsRows({ children, className }: SettingsRowsProps) {
  return <div className={cn('[&>*+*]:border-t [&>*+*]:border-settings-divider', className)}>{children}</div>;
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
  /** Show only the icons (labels become tooltips/aria labels), like claude.ai's theme switch */
  iconOnly?: boolean;
  className?: string;
}

// claude.ai's segmented-control thumb animation (measured): 200ms, snap ease
const THUMB_ANIMATION: KeyframeAnimationOptions = { duration: 200, easing: 'cubic-bezier(.32, .72, 0, 1)' };

/**
 * claude.ai segmented control: a translucent track with a raised thumb that slides (and
 * stretches) to the selected option.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  iconOnly = false,
  className
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());
  const lastRectRef = useRef<{ x: number; width: number } | null>(null);

  // Position the thumb under the selected option; animate from the previous position on change
  useLayoutEffect(() => {
    const thumb = thumbRef.current;
    const item = itemRefs.current.get(value);
    if (!thumb || !item) return;

    const place = (animate: boolean) => {
      const next = { x: item.offsetLeft, width: item.offsetWidth };
      const prev = lastRectRef.current;
      thumb.style.width = `${next.width}px`;
      thumb.style.transform = `translateX(${next.x}px)`;
      thumb.style.visibility = 'visible';
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
      if (animate && prev && !reduceMotion && (prev.x !== next.x || prev.width !== next.width)) {
        thumb.animate(
          [
            { transform: `translateX(${prev.x}px) scaleX(${prev.width / next.width})` },
            { transform: `translateX(${next.x}px) scaleX(1)` }
          ],
          THUMB_ANIMATION
        );
      }
      lastRectRef.current = next;
    };

    place(true);

    // Re-measure without animating when the layout changes (fonts loading, container resizing)
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => place(false));
    if (trackRef.current) observer.observe(trackRef.current);
    return () => observer.disconnect();
  }, [value]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex((o) => o.value === value);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(index + step + options.length) % options.length];
    onValueChange(next.value);
    itemRefs.current.get(next.value)?.focus();
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn('relative inline-flex h-8 w-fit shrink-0 items-stretch rounded-lg bg-segment-track p-px', className)}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-clip rounded-lg">
        <div
          ref={thumbRef}
          className="invisible absolute bottom-px left-0 top-px origin-left rounded-[7px] bg-segment-thumb shadow-[inset_0_0_0_1px_var(--segment-thumb-ring),0_1px_2px_0_rgb(0_0_0/0.05)]"
        />
      </div>
      {options.map((option) => {
        const isSelected = option.value === value;
        const Icon = option.icon;
        const button = (
          <button
            key={option.value}
            ref={(el) => {
              if (el) itemRefs.current.set(option.value, el);
              else itemRefs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={iconOnly && typeof option.label === 'string' ? option.label : undefined}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'relative z-[1] inline-flex h-full items-center justify-center gap-1.5 rounded-md text-sm outline-none',
              'transition-[color,box-shadow] duration-75 focus-visible:shadow-(--shadow-focus)',
              iconOnly ? 'aspect-square' : 'px-3',
              isSelected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {Icon && <Icon className={iconOnly ? 'h-[1.125rem] w-[1.125rem]' : 'h-4 w-4'} strokeWidth={1.75} />}
            {!iconOnly && <span>{option.label}</span>}
          </button>
        );
        return iconOnly ? (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>{option.label}</TooltipContent>
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
