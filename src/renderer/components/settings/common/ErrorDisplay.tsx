import { X } from 'lucide-react';

interface ErrorDisplayProps {
  error: string | null;
  envError?: string | null;
}

/**
 * Displays error messages in a consistent format.
 * Combines general errors and environment configuration errors.
 */
export function ErrorDisplay({ error, envError }: ErrorDisplayProps) {
  const displayError = error || envError;

  if (!displayError) {
    return null;
  }

  return (
    <div role="alert" className="mt-6 flex items-start gap-2 text-sm text-destructive">
      <X className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0">{displayError}</span>
    </div>
  );
}
