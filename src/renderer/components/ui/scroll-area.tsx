import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cn } from '../../lib/utils';

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportClassName?: string;
    onViewportRef?: (element: HTMLDivElement | null) => void;
  }
>(({ className, children, viewportClassName, onViewportRef, ...props }, ref) => {
  const viewportRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      onViewportRef?.(element);
    },
    [onViewportRef]
  );

  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className={cn('h-full w-full rounded-[inherit]', viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
});
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      // A 1px line 1px in from the edge that widens to a 3px thumb while hovered (claude.ai style)
      'group flex touch-none select-none',
      orientation === 'vertical' && 'h-full w-2.5 justify-end py-0.5 pr-px',
      orientation === 'horizontal' && 'h-2.5 flex-col items-stretch justify-end px-0.5 pb-px',
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb
      className={cn(
        'relative rounded-full bg-(--scrollbar-thumb) transition-[width,height] duration-100',
        'group-hover:bg-(--scrollbar-thumb-hover)',
        // `!`: Radix sets both thumb dimensions inline; only the length should come from it
        orientation === 'vertical' ? 'w-px! group-hover:w-[3px]!' : 'h-px! group-hover:h-[3px]!'
      )}
    />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
