import { useState, useEffect } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Switch } from '../../ui/switch';
import { SettingsRow, SettingsRows } from '../../settings/SettingsRow';
import type { Task, WorktreeStatus, WorktreeCreatePRResult } from '../../../../shared/types';

interface CreatePRDialogProps {
  open: boolean;
  task: Task;
  worktreeStatus: WorktreeStatus | null;
  onOpenChange: (open: boolean) => void;
  onCreatePR: (options: { targetBranch?: string; title?: string; draft?: boolean }) => Promise<WorktreeCreatePRResult | null>;
}

/**
 * Dialog for creating a Pull Request from a worktree branch
 * Allows user to specify target branch, PR title, and draft status
 */
export function CreatePRDialog({
  open,
  task,
  worktreeStatus,
  onOpenChange,
  onCreatePR
}: CreatePRDialogProps) {
  const { t } = useTranslation(['taskReview', 'common']);
  const [targetBranch, setTargetBranch] = useState('');
  const [prTitle, setPrTitle] = useState('');
  const [isDraft, setIsDraft] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [result, setResult] = useState<WorktreeCreatePRResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setTargetBranch(worktreeStatus?.baseBranch || '');
      setPrTitle(task.title);
      setIsDraft(false);
      setIsCreating(false);
      setResult(null);
      setError(null);
    }
  }, [open, worktreeStatus?.baseBranch, task.title]);

  // Frontend validation functions
  const validateBranchName = (branch: string): string | null => {
    if (!branch.trim()) return null; // Empty is OK, will use default
    // Basic git branch name rules: no spaces, .., @{, \, etc.
    if (!/^[a-zA-Z0-9/_-]+$/.test(branch)) {
      return t('taskReview:pr.errors.invalidBranchName');
    }
    return null;
  };

  const validatePRTitle = (title: string): string | null => {
    if (!title.trim()) {
      return t('taskReview:pr.errors.emptyTitle');
    }
    return null;
  };

  const handleCreatePR = async () => {
    // Frontend validation before submitting
    const branchError = validateBranchName(targetBranch);
    if (branchError) {
      setError(branchError);
      return;
    }

    const titleError = validatePRTitle(prTitle);
    if (titleError) {
      setError(titleError);
      return;
    }

    setIsCreating(true);
    setError(null);
    setResult(null);

    try {
      const prResult = await onCreatePR({
        targetBranch: targetBranch || undefined,
        title: prTitle || undefined,
        draft: isDraft
      });

      if (prResult) {
        if (prResult.success) {
          setResult(prResult);
        } else {
          setError(prResult.error || t('taskReview:pr.errors.unknown'));
        }
      } else {
        setError(t('taskReview:pr.errors.unknown'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('taskReview:pr.errors.unknown'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleOpenPR = () => {
    if (result?.prUrl && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(result.prUrl);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {t('taskReview:pr.title')}
          </DialogTitle>
          <DialogDescription>
            {t('taskReview:pr.description', { taskTitle: task.title })}
          </DialogDescription>
        </DialogHeader>

        {/* Success State */}
        {result?.success && (
          <>
            <div className="mt-4 space-y-1 text-sm">
              <p className="flex items-center gap-1.5 text-foreground">
                {result.alreadyExists
                  ? t('taskReview:pr.success.alreadyExists')
                  : t('taskReview:pr.success.created')}
              </p>
              {result.prUrl && (
                <button
                  type="button"
                  data-testid="pr-link-button"
                  onClick={handleOpenPR}
                  className="flex cursor-pointer items-center gap-1 break-all border-none bg-transparent p-0 text-left font-mono text-xs text-(--nav-label-color) hover:text-foreground hover:underline"
                >
                  {result.prUrl}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </button>
              )}
            </div>
            <DialogFooter>
              <Button size="sm" onClick={handleClose}>
                {t('common:buttons.close')}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Error State */}
        {error && !result?.success && (
          <>
            <p className="mt-4 text-sm text-destructive">{error}</p>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t('common:buttons.cancel')}
              </Button>
              <Button size="sm" onClick={handleCreatePR} disabled={isCreating}>
                {t('taskReview:pr.actions.retry')}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Form State */}
        {!result?.success && !error && (
          <>
          <div className="-mx-6 mt-2 min-h-0 overflow-y-auto px-6">
            <SettingsRows>
              {/* Branch info */}
              <div data-testid="pr-stats-container">
                <SettingsRows>
                  <SettingsRow label={t('taskReview:pr.labels.sourceBranch')}>
                    <span className="font-mono text-xs text-(--nav-label-color)">
                      {worktreeStatus?.branch || t('taskReview:pr.labels.unknown')}
                    </span>
                  </SettingsRow>
                  {worktreeStatus?.exists && (
                    <SettingsRow label={t('taskReview:pr.labels.commits')}>
                      <span className="text-sm tabular-nums text-(--nav-label-color)">{worktreeStatus.commitCount || 0}</span>
                    </SettingsRow>
                  )}
                  {worktreeStatus?.exists && (
                    <SettingsRow label={t('taskReview:pr.labels.changes')}>
                      <span className="flex gap-2 text-sm tabular-nums">
                        <span className="text-success">+{worktreeStatus.additions || 0}</span>
                        <span className="text-destructive">-{worktreeStatus.deletions || 0}</span>
                      </span>
                    </SettingsRow>
                  )}
                </SettingsRows>
              </div>

              {/* Target Branch */}
              <SettingsRow
                stacked
                htmlFor="targetBranch"
                label={t('taskReview:pr.labels.targetBranch')}
                description={t('taskReview:pr.hints.targetBranch')}
              >
                <Input
                  id="targetBranch"
                  value={targetBranch}
                  onChange={(e) => setTargetBranch(e.target.value)}
                  placeholder={worktreeStatus?.baseBranch || 'main'}
                />
              </SettingsRow>

              {/* PR Title (optional) */}
              <SettingsRow
                stacked
                htmlFor="prTitle"
                label={t('taskReview:pr.labels.prTitle')}
                description={t('taskReview:pr.hints.prTitle')}
              >
                <Input
                  id="prTitle"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                  placeholder={task.title}
                />
              </SettingsRow>

              {/* Draft PR */}
              <SettingsRow htmlFor="draft-pr-switch" label={t('taskReview:pr.labels.draftPR')}>
                <Switch
                  id="draft-pr-switch"
                  checked={isDraft}
                  onCheckedChange={setIsDraft}
                />
              </SettingsRow>
            </SettingsRows>
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={handleClose} disabled={isCreating}>
              {t('common:buttons.cancel')}
            </Button>
            <Button size="sm" onClick={handleCreatePR} disabled={isCreating}>
              {isCreating ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('taskReview:pr.actions.creating')}
                </>
              ) : (
                t('taskReview:pr.actions.create')
              )}
            </Button>
          </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
