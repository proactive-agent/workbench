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
import { getSeverityIcon } from './utils';
import type { MergeConflict, MergeStats, GitConflictInfo } from '../../../../shared/types';

interface ConflictDetailsDialogProps {
  open: boolean;
  mergePreview: { files: string[]; conflicts: MergeConflict[]; summary: MergeStats; gitConflicts?: GitConflictInfo } | null;
  stageOnly: boolean;
  onOpenChange: (open: boolean) => void;
  onMerge: () => void;
}

/**
 * Dialog displaying detailed information about merge conflicts
 */
export function ConflictDetailsDialog({
  open,
  mergePreview,
  stageOnly,
  onOpenChange,
  onMerge
}: ConflictDetailsDialogProps) {
  const { t } = useTranslation(['taskReview', 'common']);
  const conflictCount = mergePreview?.conflicts.length || 0;
  const autoMergeable = mergePreview?.summary.autoMergeable || 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('taskReview:conflicts.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('taskReview:conflicts.detected', { count: conflictCount })}
            {autoMergeable > 0 && <> {t('taskReview:conflicts.autoMergeable', { count: autoMergeable })}</>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mt-4 flex-1 overflow-auto min-h-0 -mx-6 px-6">
          {mergePreview?.conflicts && mergePreview.conflicts.length > 0 ? (
            <div className="[&>*+*]:border-t [&>*+*]:border-settings-divider">
              {mergePreview.conflicts.map((conflict, idx) => (
                <div key={idx} className="py-3 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {getSeverityIcon(conflict.severity)}
                      <span className="truncate font-mono text-xs text-foreground" title={conflict.file}>
                        {conflict.file}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-(--nav-label-color)">
                      {conflict.severity}
                      {conflict.canAutoMerge && <> · {t('taskReview:conflicts.autoMerge')}</>}
                    </span>
                  </div>
                  {(conflict.location || conflict.reason || conflict.strategy) && (
                    <div className="mt-1.5 space-y-0.5 pl-6 text-xs text-(--nav-label-color)">
                      {conflict.location && (
                        <p><span className="text-foreground/80">{t('taskReview:conflicts.location')}:</span> {conflict.location}</p>
                      )}
                      {conflict.reason && (
                        <p><span className="text-foreground/80">{t('taskReview:conflicts.reason')}:</span> {conflict.reason}</p>
                      )}
                      {conflict.strategy && (
                        <p><span className="text-foreground/80">{t('taskReview:conflicts.strategy')}:</span> {conflict.strategy}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-(--nav-label-color)">
              {t('taskReview:conflicts.none')}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:buttons.close')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onOpenChange(false);
              onMerge();
            }}
          >
            {stageOnly ? t('taskReview:merge.buttons.stageWithAIMerge') : t('taskReview:merge.buttons.mergeWithAI')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
