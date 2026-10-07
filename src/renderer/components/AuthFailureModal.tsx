import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Button } from './ui/button';
import { useAuthFailureStore } from '../stores/auth-failure-store';

interface AuthFailureModalProps {
  onOpenSettings?: () => void;
}

/**
 * Modal displayed when Claude CLI encounters an authentication failure (401 error).
 * Prompts the user to re-authenticate via Settings > Claude Profiles.
 */
export function AuthFailureModal({ onOpenSettings }: AuthFailureModalProps) {
  const { isModalOpen, authFailureInfo, hideAuthFailureModal, clearAuthFailure } = useAuthFailureStore();
  const { t } = useTranslation('common');

  if (!authFailureInfo) return null;

  const profileName = authFailureInfo.profileName || t('auth.failure.unknownProfile', 'Unknown profile');

  // Get user-friendly message for the auth failure type
  const getFailureMessage = () => {
    switch (authFailureInfo.failureType) {
      case 'expired':
        return t('auth.failure.tokenExpired', 'Your authentication token has expired.');
      case 'invalid':
        return t('auth.failure.tokenInvalid', 'Your authentication token is invalid.');
      case 'missing':
        return t('auth.failure.tokenMissing', 'No authentication token found.');
      default:
        return t('auth.failure.authFailed', 'Authentication failed.');
    }
  };

  const failureMessage = getFailureMessage();

  const handleGoToSettings = () => {
    hideAuthFailureModal();
    onOpenSettings?.();
  };

  const handleDismiss = () => {
    clearAuthFailure();
  };

  return (
    <Dialog open={isModalOpen} onOpenChange={(open) => !open && hideAuthFailureModal()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('auth.failure.title', 'Authentication required')}
          </DialogTitle>
          <DialogDescription>
            {t('auth.failure.profileLabel', 'Profile')}: {profileName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          <p className="text-sm text-foreground">
            {failureMessage}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('auth.failure.description', 'Please re-authenticate your Claude profile to continue using Auto Claude.')}
          </p>

          {authFailureInfo.taskId && (
            <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
              <p className="text-muted-foreground">
                {t('auth.failure.taskAffected', 'Task affected')}: <span className="font-mono">{authFailureInfo.taskId}</span>
              </p>
            </div>
          )}

          {authFailureInfo.originalError && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                {t('auth.failure.technicalDetails', 'Technical details')}
              </summary>
              <pre className="mt-2 rounded-xl bg-segment-track px-4 py-3 text-xs overflow-x-auto whitespace-pre-wrap break-all">
                {authFailureInfo.originalError}
              </pre>
            </details>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleDismiss}>
            {t('labels.dismiss', 'Dismiss')}
          </Button>
          <Button size="sm" onClick={handleGoToSettings}>
            {t('auth.failure.goToSettings', 'Go to settings')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
