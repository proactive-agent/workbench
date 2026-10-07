import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import type { WorktreeDiff } from '../../../../shared/types';

interface DiffViewDialogProps {
  open: boolean;
  worktreeDiff: WorktreeDiff | null;
  onOpenChange: (open: boolean) => void;
}

const FILE_STATUSES = ['added', 'deleted', 'modified', 'renamed'] as const;

/**
 * Dialog displaying the list of changed files with their status and line changes
 */
export function DiffViewDialog({
  open,
  worktreeDiff,
  onOpenChange
}: DiffViewDialogProps) {
  const { t } = useTranslation(['taskReview', 'common']);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('taskReview:diff.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {worktreeDiff?.summary || t('taskReview:diff.noChanges')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mt-4 flex-1 overflow-auto min-h-0 -mx-6 px-6">
          {worktreeDiff?.files && worktreeDiff.files.length > 0 ? (
            <div className="[&>*+*]:border-t [&>*+*]:border-settings-divider">
              {worktreeDiff.files.map((file, idx) => (
                <div key={idx} className="flex items-center justify-between gap-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={file.path}>
                    {file.path}
                  </span>
                  <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums">
                    <span className="text-(--nav-label-color)">
                      {(FILE_STATUSES as readonly string[]).includes(file.status)
                        ? t(`taskReview:diff.status.${file.status}`)
                        : file.status}
                    </span>
                    <span className="text-success">+{file.additions}</span>
                    <span className="text-destructive">-{file.deletions}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-(--nav-label-color)">
              {t('taskReview:diff.noFiles')}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:buttons.close')}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
