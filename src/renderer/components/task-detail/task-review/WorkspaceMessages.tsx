import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { persistTaskStatus, startTaskOrQueue } from '../../../stores/task-store';
import type { Task } from '../../../../shared/types';

interface LoadingMessageProps {
  message?: string;
}

/**
 * Displays a loading indicator while workspace info is being fetched
 */
export function LoadingMessage({ message }: LoadingMessageProps) {
  const { t } = useTranslation(['taskReview']);
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-(--nav-label-color)">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{message ?? t('taskReview:workspace.loading')}</span>
    </div>
  );
}

interface NoWorkspaceMessageProps {
  task?: Task;
  onClose?: () => void;
}

/**
 * Displays message when no workspace is found for the task
 */
export function NoWorkspaceMessage({ task, onClose }: NoWorkspaceMessageProps) {
  const { t } = useTranslation(['tasks', 'taskReview']);
  const [isMarkingDone, setIsMarkingDone] = useState(false);
  const [isProceeding, setIsProceeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isPlanReview =
    task?.status === 'human_review' &&
    task.reviewReason === 'plan_review';

  const handleMarkDone = async () => {
    if (!task) return;

    setIsMarkingDone(true);
    try {
      await persistTaskStatus(task.id, 'done');
      // Auto-close modal after marking as done
      onClose?.();
    } catch (err) {
      console.error('Error marking task as done:', err);
    } finally {
      setIsMarkingDone(false);
    }
  };

  const handleProceedToCoding = async () => {
    if (!task) return;

    setIsProceeding(true);
    setError(null);
    setNotice(null);
    try {
      const result = await startTaskOrQueue(task.id);
      if (!result.success) {
        setError(result.error || t('tasks:wizard.errors.startFailed'));
      } else if (result.action === 'queued') {
        setNotice(t('tasks:queue.movedToQueue'));
      }
    } catch (err) {
      console.error('Error proceeding to coding:', err);
      setError(err instanceof Error ? err.message : t('tasks:wizard.errors.startFailed'));
    } finally {
      setIsProceeding(false);
    }
  };

  return (
    <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-foreground">
            {isPlanReview ? t('taskReview:noWorkspace.planReviewTitle') : t('taskReview:noWorkspace.title')}
          </p>
          <p className="text-(--nav-label-color)">
            {isPlanReview ? t('taskReview:noWorkspace.planReviewDescription') : t('taskReview:noWorkspace.description')}
          </p>
        </div>

        {isPlanReview ? (
          <Button onClick={handleProceedToCoding} disabled={isProceeding} size="sm" className="shrink-0">
            {isProceeding ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('taskReview:noWorkspace.updating')}
              </>
            ) : (
              t('taskReview:noWorkspace.proceedToCoding')
            )}
          </Button>
        ) : task && task.status === 'human_review' && (
          <Button onClick={handleMarkDone} disabled={isMarkingDone} size="sm" className="shrink-0">
            {isMarkingDone ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('taskReview:noWorkspace.updating')}
              </>
            ) : (
              t('taskReview:stagedSuccess.markAsDone')
            )}
          </Button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-destructive">{error}</p>
      )}
      {notice && (
        <p className="mt-2 text-(--nav-label-color)">{notice}</p>
      )}
    </div>
  );
}

interface StagedInProjectMessageProps {
  task: Task;
  projectPath?: string;
  hasWorktree?: boolean;
  onClose?: () => void;
  onReviewAgain?: () => void;
}

/**
 * Displays message when changes have already been staged in the main project
 */
export function StagedInProjectMessage({ task, hasWorktree = false, onClose, onReviewAgain }: StagedInProjectMessageProps) {
  const { t } = useTranslation(['taskReview']);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isMarkingDone, setIsMarkingDone] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDeleteWorktreeAndMarkDone = async () => {
    setIsDeleting(true);
    setError(null);

    try {
      // Call the discard/delete worktree command
      // Pass skipStatusChange=true to prevent backend from resetting to 'backlog'
      // since we explicitly set status to 'done' immediately after
      const result = await window.electronAPI.discardWorktree(task.id, true);

      if (!result.success) {
        setError(result.error || t('taskReview:stagedSuccess.errors.failedToDeleteWorktree'));
        return;
      }

      // Mark task as done - check result since worktree is already deleted
      const statusResult = await persistTaskStatus(task.id, 'done');
      if (!statusResult.success) {
        // Worktree is already deleted but status update failed - inform user of inconsistent state
        setError(t('taskReview:stagedSuccess.errors.worktreeDeletedButStatusFailed', { error: statusResult.error || '' }));
        return;
      }

      // Auto-close modal after marking as done
      onClose?.();
    } catch (err) {
      console.error('Error deleting worktree:', err);
      setError(err instanceof Error ? err.message : t('taskReview:stagedSuccess.errors.failedToDeleteWorktree'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMarkDoneOnly = async () => {
    setIsMarkingDone(true);
    setError(null);

    try {
      const result = await persistTaskStatus(task.id, 'done', { keepWorktree: true });
      if (!result.success) {
        setError(result.error || t('taskReview:stagedSuccess.errors.failedToMarkAsDone'));
        return;
      }
      onClose?.();
    } catch (err) {
      console.error('Error marking task as done:', err);
      setError(err instanceof Error ? err.message : t('taskReview:stagedSuccess.errors.failedToMarkAsDone'));
    } finally {
      setIsMarkingDone(false);
    }
  };

  const handleReviewAgain = async () => {
    if (!onReviewAgain) return;

    setIsResetting(true);
    setError(null);

    try {
      // Clear the staged flag via IPC
      const result = await window.electronAPI.clearStagedState(task.id);

      if (!result.success) {
        setError(result.error || t('taskReview:stagedSuccess.errors.failedToResetStagedState'));
        return;
      }

      // Trigger re-render by calling parent callback
      onReviewAgain();
    } catch (err) {
      console.error('Error resetting staged state:', err);
      setError(err instanceof Error ? err.message : t('taskReview:stagedSuccess.errors.failedToResetStagedState'));
    } finally {
      setIsResetting(false);
    }
  };

  const anyActionInProgress = isDeleting || isMarkingDone || isResetting;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm text-foreground">{t('taskReview:stagedInProject.title')}</h3>
        <p className="mt-1 text-sm text-(--nav-label-color)">
          {task.stagedAt
            ? t('taskReview:stagedInProject.descriptionOn', { date: new Date(task.stagedAt).toLocaleDateString() })
            : t('taskReview:stagedInProject.description')}
        </p>
      </div>

      <StagedNextSteps />

      <StagedActions
        hasWorktree={hasWorktree}
        canReviewAgain={!!onReviewAgain}
        disabled={anyActionInProgress}
        isDeleting={isDeleting}
        isMarkingDone={isMarkingDone}
        isResetting={isResetting}
        onDeleteWorktreeAndMarkDone={handleDeleteWorktreeAndMarkDone}
        onMarkDoneOnly={handleMarkDoneOnly}
        onReviewAgain={handleReviewAgain}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/**
 * "Next steps" info box shown after changes were staged in the main project
 */
export function StagedNextSteps() {
  const { t } = useTranslation(['taskReview']);
  const code = 'rounded bg-nav-hover px-1 font-mono text-xs';
  return (
    <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
      <p className="mb-1.5 text-foreground">{t('taskReview:stagedSuccess.nextSteps')}</p>
      <ol className="list-inside list-decimal space-y-1 text-(--nav-label-color)">
        <li>
          {t('taskReview:stagedSuccess.reviewChanges')} <code className={code}>git status</code>{' '}
          {t('taskReview:stagedSuccess.and')} <code className={code}>git diff --staged</code>
        </li>
        <li>
          {t('taskReview:stagedSuccess.commitWhenReady')} <code className={code}>git commit -m "your message"</code>
        </li>
        <li>{t('taskReview:stagedSuccess.pushToRemote')}</li>
      </ol>
    </div>
  );
}

interface StagedActionsProps {
  hasWorktree: boolean;
  canReviewAgain: boolean;
  disabled: boolean;
  isDeleting: boolean;
  isMarkingDone: boolean;
  isResetting: boolean;
  onDeleteWorktreeAndMarkDone: () => void;
  onMarkDoneOnly: () => void;
  onReviewAgain: () => void;
}

/**
 * Right-aligned actions after staging: review again / mark done only (secondary) and the
 * primary "delete worktree & mark done" (or "mark as done" when no worktree is left).
 */
export function StagedActions({
  hasWorktree,
  canReviewAgain,
  disabled,
  isDeleting,
  isMarkingDone,
  isResetting,
  onDeleteWorktreeAndMarkDone,
  onMarkDoneOnly,
  onReviewAgain
}: StagedActionsProps) {
  const { t } = useTranslation(['taskReview']);
  const spinner = <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hasWorktree && canReviewAgain && (
          <Button onClick={onReviewAgain} disabled={disabled} size="sm" variant="outline">
            {isResetting ? <>{spinner}{t('taskReview:stagedSuccess.resetting')}</> : t('taskReview:stagedSuccess.reviewAgain')}
          </Button>
        )}
        {hasWorktree && (
          <Button onClick={onMarkDoneOnly} disabled={disabled} size="sm" variant="outline">
            {isMarkingDone ? <>{spinner}{t('taskReview:stagedSuccess.markingDone')}</> : t('taskReview:stagedSuccess.markDoneOnly')}
          </Button>
        )}
        {hasWorktree ? (
          <Button onClick={onDeleteWorktreeAndMarkDone} disabled={disabled} size="sm">
            {isDeleting ? <>{spinner}{t('taskReview:stagedSuccess.cleaningUp')}</> : t('taskReview:stagedSuccess.deleteWorktreeAndMarkDone')}
          </Button>
        ) : (
          <Button onClick={onMarkDoneOnly} disabled={disabled} size="sm">
            {isMarkingDone ? <>{spinner}{t('taskReview:stagedSuccess.markingDone')}</> : t('taskReview:stagedSuccess.markAsDone')}
          </Button>
        )}
      </div>
      {hasWorktree && (
        <p className="text-right text-xs text-(--nav-label-color)">
          {t('taskReview:stagedSuccess.worktreeExplanation')}
        </p>
      )}
    </div>
  );
}
