import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { SettingsIcon as Settings } from './icons/app-icons';
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

  const profileName = authFailureInfo.profileName || t('auth.failure.unknownProfile', 'Unknown Profile');

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
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {t('auth.failure.title', 'Authentication Required')}
          </DialogTitle>
          <DialogDescription>
            {t('auth.failure.profileLabel', 'Profile')}: {profileName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm text-foreground">
            {failureMessage}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('auth.failure.description', 'Please re-authenticate your Claude profile to continue using Auto Claude.')}
          </p>

          {authFailureInfo.taskId && (
            <div className="rounded-lg border border-border px-4 py-3 text-sm">
              <p className="text-muted-foreground">
                {t('auth.failure.taskAffected', 'Task affected')}: <span className="font-mono">{authFailureInfo.taskId}</span>
              </p>
            </div>
          )}

          {authFailureInfo.originalError && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                {t('auth.failure.technicalDetails', 'Technical details')}
              </summary>
              <pre className="mt-2 rounded-md bg-muted p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {authFailureInfo.originalError}
              </pre>
            </details>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleDismiss}>
            {t('labels.dismiss', 'Dismiss')}
          </Button>
          <Button size="sm" onClick={handleGoToSettings} className="gap-1.5">
            <Settings className="h-3.5 w-3.5" />
            {t('auth.failure.goToSettings', 'Go to Settings')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
