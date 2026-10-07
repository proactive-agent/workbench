import { useTranslation, Trans } from 'react-i18next';
import { AlertCircle, FolderX, Loader2, RefreshCw } from 'lucide-react';
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
          <AlertDialogTitle className="flex items-center gap-2">
            {error && <AlertCircle className="h-4 w-4 text-destructive" />}
            {error ? t('dialogs:worktreeCleanup.errorTitle') : t('dialogs:worktreeCleanup.title')}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-muted-foreground space-y-3">
              {error ? (
                <p className="text-destructive">{error}</p>
              ) : (
                <>
                  <p>
                    <Trans
                      i18nKey="dialogs:worktreeCleanup.hasWorktree"
                      values={{ taskTitle }}
                      components={{ strong: <strong className="text-foreground" /> }}
                    />
                  </p>
                  <p>
                    {t('dialogs:worktreeCleanup.willDelete')}
                  </p>
                </>
              )}
              {worktreePath && (
                <div className="rounded-lg border border-border px-4 py-3 font-mono text-xs break-all">
                  {worktreePath}
                </div>
              )}
              {!error && (
                <p className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-foreground">
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
              <>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('dialogs:worktreeCleanup.retry')}
              </>
            ) : (
              <>
                <FolderX className="mr-1.5 h-3.5 w-3.5" />
                {t('dialogs:worktreeCleanup.confirm')}
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
