import { Check, Loader2, X } from 'lucide-react';
import { cn } from '../../../lib/utils';

export type StatusIndicatorState = 'loading' | 'success' | 'error' | 'neutral';

interface StatusIndicatorProps {
  state: StatusIndicatorState;
  children?: React.ReactNode;
  /** Text tone: muted (default), regular foreground, or destructive */
  tone?: 'muted' | 'foreground' | 'destructive';
  className?: string;
}

const TONE_CLASS = {
  muted: 'text-(--nav-label-color)',
  foreground: 'text-foreground',
  destructive: 'text-destructive'
} as const;

/**
 * claude.ai-style status: muted text with a small leading icon
 * (spinner while checking, green check on success, red x on failure).
 */
export function StatusIndicator({ state, children, tone = 'muted', className }: StatusIndicatorProps) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-sm', TONE_CLASS[tone], className)}>
      {state === 'loading' && <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.75} />}
      {state === 'success' && <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={1.75} />}
      {state === 'error' && <X className="h-4 w-4 shrink-0 text-destructive" strokeWidth={1.75} />}
      {children}
    </span>
  );
}
