import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { TooltipProvider } from '../ui/tooltip';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { buttonVariants } from '../ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  Trash2,
  Loader2,
  Pencil,
  X,
  ArchiveRestore,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestCreate,
  GitMerge,
  Play,
  RotateCcw
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  DIALOG_ANIMATION_CLASS,
  DIALOG_CLOSE_BUTTON_CLASS,
  DIALOG_CLOSE_ICON_CLASS,
  DIALOG_CLOSE_ICON_STROKE,
  DIALOG_OVERLAY_CLASS,
  DIALOG_SURFACE_CLASS,
  DIALOG_TITLE_CLASS
} from '../ui/dialog-styles';
import { stopTask, submitReview, deleteTask, useTaskStore, startTaskOrQueue, unarchiveTasks, taskHasErrors, taskWasStopped, retryTask } from '../../stores/task-store';
import { useProjectStore } from '../../stores/project-store';
import { TASK_STATUS_LABELS, getTaskColumn, type TaskStatusColumn } from '../../../shared/constants';
import { TaskEditDialog } from '../TaskEditDialog';
import { useTaskDetail } from './hooks/useTaskDetail';
import { TaskMetadata } from './TaskMetadata';
import { TaskOpenAgentButton } from './TaskOpenAgentButton';
import { useTaskGitOptions } from '../task-form/TaskGitOptions';
import { TaskConnectorRows } from '../task-form/TaskConnectorRows';
import { useSettingsStore } from '../../stores/settings-store';
import { getDefaultMcpConnectorIds } from '../../../shared/utils/mcp-connectors';
import { TaskWarnings } from './TaskWarnings';
import { TaskLogs, isTaskRunSettled } from './TaskLogs';
import { PreviousRuns } from './PreviousRuns';
import { isTaskSessionActive } from '../../../shared/utils/claude-run';
import { TaskAttachments } from './TaskAttachments';
import { QAFeedbackSection } from './task-review/QAFeedbackSection';
import { CreatePRDialog } from './task-review/CreatePRDialog';
import { MergePRDialog } from './task-review/MergePRDialog';
import { LocalMergeDialog } from './task-review/LocalMergeDialog';
import type { Task, WorktreeCreatePROptions, WorktreeLocalMergeResult, WorktreeMergePROptions, WorktreeMergePRResult } from '../../../shared/types';

/** A branch badge for something not there yet (a branch to be created, a merge to come) */
const DRAFT_BADGE_CLASS = 'border-dashed text-muted-foreground';

// Status label colors: the top line color of each Kanban column (globals.css `--column-*`)
const STATUS_BADGE_CLASSES: Record<TaskStatusColumn, string> = {
  backlog: 'text-(--column-backlog) bg-(--column-backlog)/10',
  queue: 'text-(--column-queue) bg-(--column-queue)/10',
  in_progress: 'text-(--column-in-progress) bg-(--column-in-progress)/10',
  ai_review: 'text-(--column-ai-review) bg-(--column-ai-review)/10',
  human_review: 'text-(--column-human-review) bg-(--column-human-review)/10',
  done: 'text-(--column-done) bg-(--column-done)/10',
};

interface TaskDetailModalProps {
  open: boolean;
  task: Task | null;
  onOpenChange: (open: boolean) => void;
}

export function TaskDetailModal({ open, task, onOpenChange }: TaskDetailModalProps) {
  // Don't render anything if no task
  if (!task) {
    return null;
  }

  return (
    <TaskDetailModalContent
      open={open}
      task={task}
      onOpenChange={onOpenChange}
    />
  );
}

// Separate component to use hooks only when task exists
function TaskDetailModalContent({ open, task, onOpenChange }: { open: boolean; task: Task; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(['tasks']);
  const state = useTaskDetail({ task });
  const connectorSettings = useSettingsStore((settingsState) => settingsState.settings.mcpConnectors);
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  // Why the last footer action failed, shown in the footer (cleared by the next action)
  const [actionError, setActionError] = useState<string | null>(null);

  // Archived tasks can be brought back to the board from here
  const handleUnarchive = async () => {
    setIsUnarchiving(true);
    setActionError(null);
    const result = await unarchiveTasks(task.projectId, [task.id]);
    setIsUnarchiving(false);
    if (!result.success) setActionError(t('tasks:actions.unarchiveFailed', { error: result.error ?? '' }));
  };
  const activeProject = useProjectStore(s => s.getActiveProject());

  // Event Handlers
  const handleStartStop = async () => {
    if (state.isRunning && !state.isStuck) {
      stopTask(task.id, task.projectId);
    } else {
      setActionError(null);
      // If task is incomplete, validate and reload plan before starting
      if (state.isIncomplete) {
        const isValid = await state.reloadPlanForIncompleteTask();
        if (!isValid) {
          setActionError(t('tasks:detail.resumeFailedDescription'));
          return;
        }
      }
      // A queued task moves to the Queue column, which the dialog's status label shows
      const result = await startTaskOrQueue(task.id);
      if (!result.success) setActionError(result.error || t('tasks:wizard.errors.startFailed'));
    }
  };

  // Retry starts the task over: worktree changes and the previous run are discarded
  const handleRetry = async () => {
    setIsRetrying(true);
    setActionError(null);
    const result = await retryTask(task.id, task.projectId);
    setIsRetrying(false);
    if (result.success) {
      state.setIsStuck(false);
      state.setHasCheckedRunning(false);
      void state.reloadPreviousRuns();
    } else {
      setActionError(result.error || t('tasks:wizard.errors.startFailed'));
    }
  };

  const handleReject = async () => {
    // Allow submission if there's text feedback OR images attached
    if (!state.feedback.trim() && state.feedbackImages.length === 0) {
      return;
    }
    state.setIsSubmitting(true);
    const wasStartOver = state.startOver;
    await submitReview(task.id, false, state.feedback, state.feedbackImages, { startOver: wasStartOver }, task.projectId);
    state.setIsSubmitting(false);
    if (wasStartOver) void state.reloadPreviousRuns();
    state.setFeedback('');
    state.setFeedbackImages([]);
    state.setStartOver(false);
  };

  const handleDelete = async () => {
    state.setIsDeleting(true);
    state.setDeleteError(null);
    const result = await deleteTask(task.id, task.projectId);
    if (result.success) {
      state.setShowDeleteDialog(false);
      onOpenChange(false);
    } else {
      state.setDeleteError(result.error || t('tasks:deleteDialog.failed'));
    }
    state.setIsDeleting(false);
  };

  // The worktree calls below take the task's own project last: a task id is only unique inside
  // its project, so without it the main process would search the projects for the id and could
  // open a pull request for, or merge, another project's worktree of the same name
  const handleCreatePR = async (options: WorktreeCreatePROptions) => {
    state.setIsCreatingPR(true);
    try {
      const result = await window.electronAPI.createWorktreePR(task.id, options, task.projectId);
      if (result.success && result.data) {
        // Update single task in store with new status and prUrl (more efficient than reloading all tasks)
        // The task waits in Human Review (PR Created) until its PR is merged
        if (result.data.success && result.data.prUrl && !result.data.alreadyExists) {
          useTaskStore.getState().updateTask(task.id, {
            status: 'pr_created',
            metadata: { ...task.metadata, prUrl: result.data.prUrl, prState: 'open' }
          });
        }
        return result.data;
      }
      // Propagate IPC error; let CreatePRDialog use its i18n fallback
      return { success: false, error: result.error, prUrl: undefined, alreadyExists: false };
    } catch (error) {
      // Propagate actual error message; let CreatePRDialog handle i18n fallback for undefined
      return { success: false, error: error instanceof Error ? error.message : undefined, prUrl: undefined, alreadyExists: false };
    } finally {
      state.setIsCreatingPR(false);
    }
  };

  // A merged PR moves the task to Done
  const handleMergePR = async (options: WorktreeMergePROptions): Promise<WorktreeMergePRResult> => {
    const result = await window.electronAPI.mergeWorktreePR(task.id, options, task.projectId);
    if (!result.success || !result.data) return { success: false, error: result.error };
    if (result.data.success) {
      useTaskStore.getState().updateTask(task.id, { status: 'done', metadata: { ...task.metadata, prState: 'merged' } });
    }
    return result.data;
  };

  // A local merge (plain git, nothing pushed) moves the task to Done
  const handleLocalMerge = async (): Promise<WorktreeLocalMergeResult> => {
    const result = await window.electronAPI.mergeWorktreeLocal(task.id, task.projectId);
    if (!result.success || !result.data) return { success: false, error: result.error };
    if (result.data.success) {
      useTaskStore.getState().updateTask(task.id, { status: 'done' });
    }
    return result.data;
  };

  // The PR's state is stored with the task; read it from GitHub once when it never was
  const prStateRequested = useRef(false);
  const prUrl = task.metadata?.prUrl;
  const prState = task.metadata?.prState;
  useEffect(() => {
    if (!open || !prUrl || prState || prStateRequested.current) return;
    prStateRequested.current = true;
    void window.electronAPI.getWorktreePRState(task.id, task.projectId).then((result) => {
      if (!result.success || !result.data) return;
      const current = useTaskStore.getState().tasks.find((candidate) => candidate.id === task.id);
      if (current) useTaskStore.getState().updateTask(task.id, { metadata: { ...current.metadata, prState: result.data } });
    });
  }, [open, prUrl, prState, task.id, task.projectId]);
  // Only an open PR can be merged, and not while the task runs
  const canMergePR = !!prUrl && prState === 'open' && task.status !== 'in_progress' && task.status !== 'ai_review';

  // Merging into the base branch, and opening a pull request against it, both need the project
  // to still have it: the branch the task's Git options label "Not in the project"
  // Whether the task's worktree (and branch) exists: its status says so in review; otherwise a run
  // was started, which creates the worktree first
  const worktreeExists = state.worktreeStatus
    ? state.worktreeStatus.exists
    : task.metadata?.useWorktree !== false && !!task.claudeRun;
  // The worktree's base branch, or the one runs pick for it: the task's own, else the project's
  // default branch (no git calls here)
  const { isMissingBranch, projectDefaultBranch } = useTaskGitOptions(task.projectId, state.worktreeStatus?.baseBranch);
  const baseBranch = state.worktreeStatus?.exists
    ? state.worktreeStatus.baseBranch
    : task.metadata?.baseBranch || projectDefaultBranch || undefined;
  const baseBranchMissing = isMissingBranch(baseBranch);
  const baseBranchMissingTitle = baseBranchMissing
    ? t('taskReview:workspace.baseBranchMissing', { branch: baseBranch })
    : undefined;

  return (
    <TooltipProvider delayDuration={300}>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          {/* Semi-transparent overlay - can see background content */}
          <DialogPrimitive.Overlay className={DIALOG_OVERLAY_CLASS} />

          {/* Full-height centered modal content */}
          <DialogPrimitive.Content
            className={cn(
              'fixed left-1/2 top-1/2 z-50',
              '-translate-x-1/2 -translate-y-1/2',
              'w-[min(760px,calc(100vw-2rem))] h-[min(600px,calc(100vh-2rem))]',
              'overflow-hidden flex flex-col',
              DIALOG_SURFACE_CLASS,
              DIALOG_ANIMATION_CLASS
            )}
          >
            {/* Header */}
            {/* pr-14 keeps the title clear of the close button */}
            <div className="relative shrink-0 px-6 pb-4 pr-14 pt-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <DialogPrimitive.Title className={cn(DIALOG_TITLE_CLASS, 'truncate')}>
                    {task.title}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description asChild>
                    <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                      {/* The task's branch: a draft (dashed, muted) until its worktree is created */}
                      <Badge
                        variant="outline"
                        className={cn('text-xs font-mono', !worktreeExists && DRAFT_BADGE_CLASS)}
                        title={t(worktreeExists ? 'tasks:detailHeader.taskBranch' : 'tasks:detailHeader.taskBranchDraft')}
                      >
                        {task.specId}
                      </Badge>
                      {/* The task's base branch: what it was (or will be) branched from, and what it
                          merges into. A draft until the task is merged */}
                      <span className="text-xs text-muted-foreground" aria-hidden="true">→</span>
                      <Badge
                        variant="outline"
                        className={cn('text-xs font-mono', DRAFT_BADGE_CLASS)}
                        title={baseBranchMissingTitle ?? t('taskReview:workspace.targetBranch')}
                      >
                        {/* A branch the project no longer has reads as disabled, like the
                            buttons that cannot use it; the tag itself keeps its look */}
                        <span className={cn(baseBranchMissing && 'opacity-50')}>
                          {baseBranch || 'main'}
                        </span>
                      </Badge>
                      {/* Status labels share one look: text and border in the color, 10% tint */}
                      {state.isStuck ? (
                        <Badge variant="outline" className="text-xs border-current bg-warning/10 text-warning">
                          {t('tasks:detailHeader.stuck')}
                        </Badge>
                      ) : state.isIncomplete ? (
                        <Badge variant="outline" className="text-xs border-current bg-warning/10 text-warning">
                          {t('tasks:detailHeader.incomplete')}
                        </Badge>
                      ) : taskHasErrors(task) ? (
                        <Badge variant="outline" className="text-xs border-current bg-red-500/10 text-red-500">
                          {t('tasks:detailHeader.failed')}
                        </Badge>
                      ) : (
                        // Same color as the top line of the task's Kanban column
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-xs border-current',
                            STATUS_BADGE_CLASSES[getTaskColumn(task.status)],
                            task.status === 'in_progress' && 'status-running'
                          )}
                        >
                          {t(TASK_STATUS_LABELS[task.status])}
                        </Badge>
                      )}
                    </div>
                  </DialogPrimitive.Description>
                  {window.DEBUG && (
                    <div className="mt-1 text-[11px] text-muted-foreground font-mono">
                      status={task.status} reviewReason={task.reviewReason ?? 'none'} phase={task.executionProgress?.phase ?? 'none'} session={task.claudeRun?.sessionId ?? 'none'}
                      <br />
                      projectId={activeProject?.id ?? 'none'} projectName={activeProject?.name ?? 'none'}
                    </div>
                  )}
                </div>
                <div className="absolute right-3 top-3 z-10 flex items-center gap-1 electron-no-drag">
                  <DialogPrimitive.Close
                    className={cn(DIALOG_CLOSE_BUTTON_CLASS, 'static')}
                    aria-label={t('common:buttons.close')}
                  >
                    <X className={DIALOG_CLOSE_ICON_CLASS} strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  </DialogPrimitive.Close>
                </div>
              </div>


              {/* Warnings: as wide as the body content (-mr-8 undoes the header's extra pr-14 room
                  for the close button, so the box lines up with the description's px-6 edge) */}
              {/* (A stuck task has no note: its label says Stuck and Retry starts it over) */}
              {state.isIncomplete && !state.isStuck && (
                <div className="mt-3 -mr-8">
                  <TaskWarnings
                    taskProgress={state.taskProgress}
                    onResume={handleStartStop}
                  />
                </div>
              )}
            </div>

            {/* Body: one scrolling page (details, review, logs). A plain scroll container: the
                ScrollArea viewport sizes to its content, so long log rows would widen the page */}
            <div className="flex-1 min-h-0 overflow-hidden">
                  <div className="h-full overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
                    <div className="px-6 pb-6 pt-2 space-y-5 overflow-x-hidden max-w-full">
                      {/* Metadata */}
                      <TaskMetadata
                        task={task}
                        worktreeStatus={state.worktreeStatus}
                        worktreeAction={(task.claudeRun?.sessionId || task.metadata?.prUrl || (state.needsReview && state.worktreeStatus?.exists)) ? (
                          <>
                            <TaskOpenAgentButton task={task} />
                            {/* Merge the task branch into its base branch with git, in the project.
                                A disabled button gets no pointer events, so its reason sits on a wrapper */}
                            {state.needsReview && state.worktreeStatus?.exists && (
                              <span title={baseBranchMissingTitle} className="inline-flex">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="gap-1.5"
                                  onClick={() => state.setShowLocalMergeDialog(true)}
                                  disabled={baseBranchMissing}
                                >
                                  <GitMerge className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                                  {t('common:buttons.localMerge')}
                                </Button>
                              </span>
                            )}
                            {/* A PR that exists opens in the browser; otherwise create one (primary action) */}
                            {task.metadata?.prUrl ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="gap-1.5"
                                  onClick={() => void window.electronAPI.openExternal(task.metadata!.prUrl!)}
                                >
                                  <GitPullRequest className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                                  {t('common:buttons.openPR')}
                                </Button>
                                {canMergePR && (
                                  <Button size="sm" className="gap-1.5" onClick={() => state.setShowMergePRDialog(true)}>
                                    <GitPullRequestArrow className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                                    {t('common:buttons.mergePR')}
                                  </Button>
                                )}
                              </>
                            ) : state.needsReview && state.worktreeStatus?.exists && (
                              <span title={baseBranchMissingTitle} className="inline-flex">
                                <Button
                                  size="sm"
                                  className="gap-1.5"
                                  onClick={() => state.setShowPRDialog(true)}
                                  disabled={state.isCreatingPR || baseBranchMissing}
                                >
                                  {state.isCreatingPR ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <GitPullRequestCreate className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                                  )}
                                  {state.isCreatingPR ? t('taskReview:pr.actions.creating') : t('common:buttons.createPR')}
                                </Button>
                              </span>
                            )}
                          </>
                        ) : undefined}
                      />

                      {/* The task's connectors, as the edit dialog sets them (read-only here) */}
                      <section>
                        <h3 className="mb-1 text-sm text-foreground">{t('tasks:form.sections.connectors')}</h3>
                        <TaskConnectorRows
                          value={task.metadata?.mcpConnectors ?? getDefaultMcpConnectorIds(connectorSettings)}
                          playwrightBrowser={task.metadata?.playwrightBrowser}
                          readOnly
                          idPrefix="detail-"
                        />
                      </section>

                      {/* Runs the task was started over from, above the change request */}
                      <PreviousRuns
                        runs={state.previousRuns}
                        openRuns={state.openPreviousRuns}
                        onToggleRun={state.togglePreviousRun}
                      />

                      {/* Human Review: request changes (Claude Code continues the same session) */}
                      {state.needsReview && (
                        <QAFeedbackSection
                          feedback={state.feedback}
                          isSubmitting={state.isSubmitting}
                          onFeedbackChange={state.setFeedback}
                          onReject={handleReject}
                          images={state.feedbackImages}
                          onImagesChange={state.setFeedbackImages}
                          startOver={state.startOver}
                          onStartOverChange={state.setStartOver}
                        />
                      )}

                      {/* Opened by the Create PR button next to the worktree changes */}
                      <CreatePRDialog
                        open={state.showPRDialog}
                        task={task}
                        worktreeStatus={state.worktreeStatus}
                        onOpenChange={state.setShowPRDialog}
                        onCreatePR={handleCreatePR}
                      />

                      {/* Opened by the Merge PR button next to Open PR */}
                      <MergePRDialog
                        open={state.showMergePRDialog}
                        task={task}
                        worktreeStatus={state.worktreeStatus}
                        onOpenChange={state.setShowMergePRDialog}
                        onMergePR={handleMergePR}
                      />

                      {/* Opened by the Local merge button next to Open agent */}
                      <LocalMergeDialog
                        open={state.showLocalMergeDialog}
                        task={task}
                        worktreeStatus={state.worktreeStatus}
                        onOpenChange={state.setShowLocalMergeDialog}
                        onMerge={handleLocalMerge}
                      />

                      {/* The description's attachments and the logs of all steps, under Request changes;
                          each dropdown shows only when it has something to show */}
                      <div className="space-y-1">
                        {task.metadata?.attachedImages && task.metadata.attachedImages.length > 0 && (
                          <TaskAttachments task={task} attachments={task.metadata.attachedImages} />
                        )}
                        {/* With the previous runs listed above them, the current run's logs need a
                            heading of their own to stand apart. Review state says nothing about
                            that: a task started over is running again long before it comes back
                            for review, and its heading says so. */}
                        <TaskLogs
                          phaseLogs={state.phaseLogs}
                          runPhases={task.claudeRun?.phases}
                          legacyLogs={task.logs}
                          isSettled={isTaskRunSettled(task.status)}
                          heading={state.previousRuns.length > 0 ? {
                            title: t(isTaskSessionActive(task) ? 'tasks:currentRun.runningTitle' : 'tasks:currentRun.title'),
                            description: t(isTaskSessionActive(task) ? 'tasks:currentRun.runningDescription' : 'tasks:currentRun.description')
                          } : undefined}
                          isLoadingLogs={state.isLoadingLogs}
                          isExpanded={state.isLogsExpanded}
                          onToggle={state.toggleLogs}
                        />
                      </div>
                    </div>
                  </div>
            </div>

            {/* Footer: task actions (the close button stays at the top) */}
            <div className="flex shrink-0 items-center justify-end gap-2 px-6 py-3 electron-no-drag">
              {/* The last action's failure, left of the buttons */}
              {actionError && (
                <p role="alert" className="mr-auto min-w-0 truncate text-sm text-destructive" title={actionError}>
                  {actionError}
                </p>
              )}
              {task.metadata?.archivedAt && (
                <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleUnarchive} disabled={isUnarchiving}>
                  {isUnarchiving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArchiveRestore className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  )}
                  {t('tasks:actions.unarchive')}
                </Button>
              )}
              {/* Failed, stopped or stuck (marked running without a run): start over from a clean
                  worktree, discarding the previous run */}
              {(state.isStuck || ((taskHasErrors(task) || taskWasStopped(task)) && !state.isRunning)) && (
                <Button variant="ghost" size="sm" className="gap-1.5" disabled={isRetrying} onClick={() => void handleRetry()}>
                  {isRetrying ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  )}
                  {t('tasks:actions.retry')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => state.setShowDeleteDialog(true)}
                disabled={state.isRunning && !state.isStuck}
              >
                <Trash2 className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                {t('tasks:actions.delete')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => state.setIsEditDialogOpen(true)}
                disabled={state.isRunning && !state.isStuck}
              >
                <Pencil className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                {t('tasks:actions.edit')}
              </Button>
              {/* Start a task waiting in Planning (Backlog) */}
              {task.status === 'backlog' && (
                <Button size="sm" className="gap-1.5" onClick={() => void handleStartStop()}>
                  <Play className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  {t('tasks:actions.start')}
                </Button>
              )}
            </div>

          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Edit Task Dialog */}
      <TaskEditDialog
        task={task}
        open={state.isEditDialogOpen}
        onOpenChange={state.setIsEditDialogOpen}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={state.showDeleteDialog} onOpenChange={state.setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tasks:deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  {t('tasks:deleteDialog.confirmMessage')} <span className="text-foreground">"{task.title}"</span>?
                </p>
                {state.isCheckingChanges && (
                  <p className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('tasks:deleteDialog.checkingChanges')}
                  </p>
                )}
                {state.worktreeChangesInfo?.hasChanges && (
                  <p className="text-destructive">
                    {t('tasks:deleteDialog.uncommittedChanges', { count: state.worktreeChangesInfo.changedFileCount })}.{' '}
                    {t('tasks:deleteDialog.uncommittedChangesHint')}
                  </p>
                )}
                <p className="rounded-xl bg-segment-track px-4 py-3 text-foreground">
                  {t('tasks:deleteDialog.destructiveWarning')}
                </p>
                {state.deleteError && (
                  <p className="text-destructive">{state.deleteError}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={state.isDeleting}>{t('tasks:deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={state.isDeleting}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              {state.isDeleting ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('tasks:deleteDialog.deleting')}
                </>
              ) : (
                t('tasks:deleteDialog.deletePermanently')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
