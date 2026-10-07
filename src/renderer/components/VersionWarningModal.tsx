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

interface VersionWarningModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
}

/**
 * One-time modal shown for version 2.7.5 to notify users they need to re-authenticate.
 * Only shown once per user - dismissal is persisted in app settings.
 */
export function VersionWarningModal({ isOpen, onClose, onOpenSettings }: VersionWarningModalProps) {
  const { t } = useTranslation('dialogs');

  const handleGoToSettings = () => {
    onClose();
    onOpenSettings?.();
  };

  const handleDismiss = () => {
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" hideCloseButton>
        <DialogHeader>
          <DialogTitle>
            {t('versionWarning.title')}
          </DialogTitle>
          <DialogDescription>
            {t('versionWarning.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          <p className="text-sm text-foreground">
            {t('versionWarning.description')}
          </p>

          <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
            <p className="text-sm text-foreground mb-2">
              {t('versionWarning.instructions')}
            </p>
            <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
              <li>{t('versionWarning.step1')}</li>
              <li>{t('versionWarning.step2')}</li>
              <li>{t('versionWarning.step3')}</li>
            </ol>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleDismiss}>
            {t('versionWarning.gotIt')}
          </Button>
          <Button size="sm" onClick={handleGoToSettings}>
            {t('versionWarning.goToSettings')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
