import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { ExternalLinkIcon } from '../icons/app-icons';
import { cn } from '../../lib/utils';

interface ExternalLinkProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  /** URL opened in the system browser; omit when `onClick` handles opening */
  href?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  /** Classes for the trailing arrow icon (size, color) */
  iconClassName?: string;
}

/**
 * Text link that opens outside the app: plain foreground text with a small muted up-right arrow
 * after it, underlined on hover (the task detail's link style). Not a button-looking control.
 */
export function ExternalLink({ href, onClick, children, className, iconClassName, ...props }: ExternalLinkProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        if (onClick) {
          onClick(event);
        } else if (href) {
          window.electronAPI?.openExternal?.(href);
        }
      }}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-left text-sm text-foreground',
        'underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none',
        className
      )}
      {...props}
    >
      {children}
      <ExternalLinkIcon className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', iconClassName)} aria-hidden="true" />
    </button>
  );
}
