import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { cn } from '../../lib/utils';

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, checked, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    checked={checked}
    className={cn(
      // claude.ai checkbox: 5px radius, translucent fill with a hairline ring; accent blue once checked
      'peer h-4 w-4 shrink-0 rounded-[5px] border-0 bg-segment-track shadow-[inset_0_0_0_1px_var(--switch-track-hover)] outline-none',
      'transition-colors duration-100 focus-visible:shadow-(--shadow-focus)',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-switch-on data-[state=checked]:text-white data-[state=checked]:shadow-none',
      'data-[state=indeterminate]:bg-switch-on data-[state=indeterminate]:text-white data-[state=indeterminate]:shadow-none',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn('flex items-center justify-center text-current')}
    >
      {checked === 'indeterminate' ? (
        <Minus className="h-3 w-3" strokeWidth={3} />
      ) : (
        <Check className="h-3 w-3" strokeWidth={3} />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
