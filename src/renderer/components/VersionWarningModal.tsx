import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronRight } from 'lucide-react';
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
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {t('versionWarning.title')}
          </DialogTitle>
          <DialogDescription>
            {t('versionWarning.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm text-foreground">
            {t('versionWarning.description')}
          </p>

          <div className="rounded-lg border border-border px-4 py-3 text-sm">
            <p className="text-sm font-medium mb-3">
              {t('versionWarning.instructions')}
            </p>
            <ol className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">1</span>
                {t('versionWarning.step1')}
              </li>
              <li className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">2</span>
                {t('versionWarning.step2')}
              </li>
              <li className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">3</span>
                {t('versionWarning.step3')}
              </li>
            </ol>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleDismiss}>
            {t('versionWarning.gotIt')}
          </Button>
          <Button size="sm" onClick={handleGoToSettings} className="gap-1.5">
            <Settings className="h-3.5 w-3.5" />
            {t('versionWarning.goToSettings')}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
