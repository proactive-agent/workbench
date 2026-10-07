import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '../../lib/utils';

/**
 * claude.ai switch: 20px-high track (36px wide, 2px padding) with a 16px white knob that
 * slides 16px using a quick overshoot ease. Track: translucent when off, accent blue when on.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-[2px] outline-none',
      'transition-colors duration-150',
      'bg-switch-track hover:bg-switch-track-hover',
      'data-[state=checked]:bg-switch-on data-[state=checked]:hover:bg-switch-on-hover',
      'focus-visible:shadow-(--shadow-focus)',
      'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-switch-track data-[state=checked]:disabled:hover:bg-switch-on',
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block size-4 rounded-full bg-switch-knob shadow-sm',
        'transition-transform duration-[120ms] ease-(--ease-overshoot) motion-reduce:transition-none',
        'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0'
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
