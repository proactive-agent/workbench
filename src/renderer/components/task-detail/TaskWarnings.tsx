import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button';

interface TaskWarningsProps {
  isStuck: boolean;
  isIncomplete: boolean;
  isRecovering: boolean;
  taskProgress: { completed: number; total: number };
  onRecover: () => void;
  onResume: () => void;
}

/**
 * Stuck / incomplete task notices, shown as a claude.ai info box with the action on the right.
 */
export function TaskWarnings({
  isStuck,
  isIncomplete,
  isRecovering,
  taskProgress,
  onRecover,
  onResume
}: TaskWarningsProps) {
  const { t } = useTranslation(['tasks']);

  if (!isStuck && !isIncomplete) return null;

  if (isStuck) {
    return (
      <div className="flex items-center gap-4 rounded-xl bg-segment-track px-4 py-3 text-sm">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-foreground">{t('tasks:warnings.stuckTitle')}</p>
          <p className="text-(--nav-label-color)">{t('tasks:warnings.stuckDescription')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRecover} disabled={isRecovering} className="shrink-0">
          {isRecovering ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t('tasks:warnings.recovering')}
            </>
          ) : (
            t('tasks:warnings.recover')
          )}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 rounded-xl bg-segment-track px-4 py-3 text-sm">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground">{t('tasks:warnings.incompleteTitle')}</p>
        <p className="text-(--nav-label-color)">
          {t('tasks:warnings.incompleteDescription', {
            completed: taskProgress.completed,
            total: taskProgress.total
          })}
        </p>
      </div>
      <Button size="sm" onClick={onResume} className="shrink-0">
        {t('tasks:warnings.resume')}
      </Button>
    </div>
  );
}
