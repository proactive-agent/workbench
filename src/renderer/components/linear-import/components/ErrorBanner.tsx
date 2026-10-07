/**
 * Error message shown above the issue list
 */

interface ErrorBannerProps {
  error: string;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  return (
    <p className="text-sm text-destructive" role="alert">
      {error}
    </p>
  );
}
