import { useTranslation, Trans } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

interface WorktreeCleanupDialogProps {
  open: boolean;
  taskTitle: string;
  worktreePath?: string;
  isProcessing: boolean;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/**
 * Confirmation dialog for cleaning up worktree when marking task as done
 */
export function WorktreeCleanupDialog({
  open,
  taskTitle,
  worktreePath,
  isProcessing,
  error,
  onOpenChange,
  onConfirm
}: WorktreeCleanupDialogProps) {
  const { t } = useTranslation(['dialogs', 'common']);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {error ? t('dialogs:worktreeCleanup.errorTitle') : t('dialogs:worktreeCleanup.title')}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {error ? (
                <p className="text-destructive">{error}</p>
              ) : (
                <>
                  <p>
                    <Trans
                      i18nKey="dialogs:worktreeCleanup.hasWorktree"
                      values={{ taskTitle }}
                      components={{ strong: <span className="text-foreground" /> }}
                    />
                  </p>
                  <p>
                    {t('dialogs:worktreeCleanup.willDelete')}
                  </p>
                </>
              )}
              {worktreePath && (
                <div className="rounded-xl border border-border px-4 py-3 font-mono text-xs break-all text-foreground">
                  {worktreePath}
                </div>
              )}
              {!error && (
                <p className="rounded-xl bg-segment-track px-4 py-3 text-foreground">
                  {t('dialogs:worktreeCleanup.warning')}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isProcessing}>{t('common:buttons.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={isProcessing}
          >
            {isProcessing ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('dialogs:worktreeCleanup.completing')}
              </>
            ) : error ? (
              t('dialogs:worktreeCleanup.retry')
            ) : (
              t('dialogs:worktreeCleanup.confirm')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
