import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check } from 'lucide-react';
import { Button } from '../../ui/button';
import { Textarea } from '../../ui/textarea';
import { persistTaskStatus } from '../../../stores/task-store';
import { StagedActions, StagedNextSteps } from './WorkspaceMessages';
import type { Task } from '../../../../shared/types';

interface StagedSuccessMessageProps {
  stagedSuccess: string;
  suggestedCommitMessage?: string;
  task: Task;
  hasWorktree?: boolean;
  projectPath?: string;
  onClose?: () => void;
  onReviewAgain?: () => void;
}

/**
 * Displays success message after changes have been freshly staged in the main project.
 * Includes AI-generated commit message and action buttons (mark done, delete worktree, review again).
 */
export function StagedSuccessMessage({
  stagedSuccess,
  suggestedCommitMessage,
  task,
  hasWorktree = false,
  onClose,
  onReviewAgain
}: StagedSuccessMessageProps) {
  const { t } = useTranslation(['taskReview']);
  const [commitMessage, setCommitMessage] = useState(suggestedCommitMessage || '');
  const [copied, setCopied] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isMarkingDone, setIsMarkingDone] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCopy = async () => {
    if (!commitMessage) return;
    try {
      await navigator.clipboard.writeText(commitMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleDeleteWorktreeAndMarkDone = async () => {
    setIsDeleting(true);
    setError(null);

    try {
      const result = await window.electronAPI.discardWorktree(task.id, true);

      if (!result.success) {
        setError(result.error || t('taskReview:stagedSuccess.errors.failedToDeleteWorktree'));
        return;
      }

      const statusResult = await persistTaskStatus(task.id, 'done');
      if (!statusResult.success) {
        setError(t('taskReview:stagedSuccess.errors.worktreeDeletedButStatusFailed', { error: statusResult.error || 'Unknown error' }));
        return;
      }

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
      const result = await window.electronAPI.clearStagedState(task.id);

      if (!result.success) {
        setError(result.error || t('taskReview:stagedSuccess.errors.failedToResetStagedState'));
        return;
      }

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
        <h3 className="flex items-center gap-1.5 text-sm text-foreground">
          <Check className="h-4 w-4 text-success" strokeWidth={1.75} />
          {t('taskReview:stagedSuccess.title')}
        </h3>
        <p className="mt-1 text-sm text-(--nav-label-color)">{stagedSuccess}</p>
      </div>

      {/* AI-generated commit message */}
      {suggestedCommitMessage && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-foreground">{t('taskReview:stagedSuccess.aiCommitMessage')}</p>
            <Button variant="ghost" size="sm" onClick={handleCopy} disabled={!commitMessage}>
              {copied ? (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5 text-success" />
                  {t('taskReview:stagedSuccess.copied')}
                </>
              ) : (
                <>
                  <Copy className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
                  {t('taskReview:stagedSuccess.copy')}
                </>
              )}
            </Button>
          </div>
          <Textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            className="min-h-[100px] resize-y font-mono text-xs"
            placeholder={t('taskReview:stagedSuccess.commitMessagePlaceholder')}
          />
          <p className="text-xs text-(--nav-label-color)">
            {t('taskReview:stagedSuccess.editHint')} <code className="rounded bg-nav-hover px-1 font-mono">git commit -m "..."</code>
          </p>
        </div>
      )}

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
