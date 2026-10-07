import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import { buttonVariants } from '../../ui/button';
import type { Task, WorktreeStatus } from '../../../../shared/types';

interface DiscardDialogProps {
  open: boolean;
  task: Task;
  worktreeStatus: WorktreeStatus | null;
  isDiscarding: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
}

/**
 * Confirmation dialog for discarding build changes
 */
export function DiscardDialog({
  open,
  task,
  worktreeStatus,
  isDiscarding,
  onOpenChange,
  onDiscard
}: DiscardDialogProps) {
  const { t } = useTranslation(['taskReview', 'common']);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('taskReview:discard.title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                {t('taskReview:discard.confirmMessage')} <span className="text-foreground">"{task.title}"</span>?
              </p>
              <p className="rounded-xl bg-segment-track px-4 py-3 text-foreground">
                {t('taskReview:discard.warning')}
              </p>
              {worktreeStatus?.exists && (
                <div className="[&>*+*]:border-t [&>*+*]:border-settings-divider">
                  <div className="flex items-center justify-between py-2">
                    <span>{t('taskReview:discard.filesChanged')}</span>
                    <span className="tabular-nums text-foreground">{worktreeStatus.filesChanged || 0}</span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span>{t('taskReview:discard.lines')}</span>
                    <span className="flex gap-2 tabular-nums">
                      <span className="text-success">+{worktreeStatus.additions || 0}</span>
                      <span className="text-destructive">-{worktreeStatus.deletions || 0}</span>
                    </span>
                  </div>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDiscarding}>{t('common:buttons.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onDiscard();
            }}
            disabled={isDiscarding}
            className={buttonVariants({ variant: 'destructive', size: 'sm' })}
          >
            {isDiscarding ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('taskReview:discard.discarding')}
              </>
            ) : (
              t('taskReview:discard.confirm')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
