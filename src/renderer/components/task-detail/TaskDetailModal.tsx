import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useToast } from '../../hooks/use-toast';
import { Separator } from '../ui/separator';
import { Tabs, TabsContent } from '../ui/tabs';
import { SegmentedControl } from '../settings/SettingsRow';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipProvider } from '../ui/tooltip';
import { Badge } from '../ui/badge';
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
  AlertTriangle,
  Pencil,
  X,
  ArchiveRestore
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
import { stopTask, submitReview, recoverStuckTask, deleteTask, useTaskStore, startTaskOrQueue, unarchiveTasks } from '../../stores/task-store';
import { useProjectStore } from '../../stores/project-store';
import { TASK_STATUS_LABELS } from '../../../shared/constants';
import { TaskEditDialog } from '../TaskEditDialog';
import { useTaskDetail } from './hooks/useTaskDetail';
import { TaskMetadata } from './TaskMetadata';
import { TaskWarnings } from './TaskWarnings';
import { TaskSubtasks } from './TaskSubtasks';
import { TaskLogs } from './TaskLogs';
import { TaskReview } from './TaskReview';
import type { Task, WorktreeCreatePROptions } from '../../../shared/types';

interface TaskDetailModalProps {
  open: boolean;
  task: Task | null;
  onOpenChange: (open: boolean) => void;
  onSwitchToTerminals?: () => void;
  onOpenInbuiltTerminal?: (id: string, cwd: string) => void;
}

export function TaskDetailModal({ open, task, onOpenChange, onSwitchToTerminals, onOpenInbuiltTerminal }: TaskDetailModalProps) {
  // Don't render anything if no task
  if (!task) {
    return null;
  }

  return (
    <TaskDetailModalContent
      open={open}
      task={task}
      onOpenChange={onOpenChange}
      onSwitchToTerminals={onSwitchToTerminals}
      onOpenInbuiltTerminal={onOpenInbuiltTerminal}
    />
  );
}

// Separate component to use hooks only when task exists
function TaskDetailModalContent({ open, task, onOpenChange, onSwitchToTerminals, onOpenInbuiltTerminal }: { open: boolean; task: Task; onOpenChange: (open: boolean) => void; onSwitchToTerminals?: () => void; onOpenInbuiltTerminal?: (id: string, cwd: string) => void }) {
  const { t } = useTranslation(['tasks']);
  const { toast } = useToast();
  const state = useTaskDetail({ task });
  const [isUnarchiving, setIsUnarchiving] = useState(false);

  // Archived tasks can be brought back to the board from here
  const handleUnarchive = async () => {
    setIsUnarchiving(true);
    const result = await unarchiveTasks(task.projectId, [task.id]);
    setIsUnarchiving(false);
    if (!result.success) {
      toast({
        title: t('tasks:actions.unarchiveFailed', { error: result.error ?? '' }),
        variant: 'destructive'
      });
    }
  };
  const activeProject = useProjectStore(s => s.getActiveProject());
  const completedSubtasks = task.subtasks.filter(s => s.status === 'completed').length;
  const totalSubtasks = task.subtasks.length;

  // Event Handlers
  const handleStartStop = async () => {
    if (state.isRunning && !state.isStuck) {
      stopTask(task.id);
    } else {
      // If task is incomplete, validate and reload plan before starting
      if (state.isIncomplete) {
        const isValid = await state.reloadPlanForIncompleteTask();
        if (!isValid) {
          toast({
            title: t('tasks:detail.resumeFailedTitle'),
            description: t('tasks:detail.resumeFailedDescription'),
            variant: 'destructive',
            duration: 5000,
          });
          return;
        }
      }
      const result = await startTaskOrQueue(task.id);
      if (!result.success) {
        toast({
          title: t('tasks:wizard.errors.startFailed'),
          description: result.error,
          variant: 'destructive',
        });
      } else if (result.action === 'queued') {
        toast({ title: t('tasks:queue.movedToQueue') });
      }
    }
  };

  const handleRecover = async () => {
    state.setIsRecovering(true);
    const result = await recoverStuckTask(task.id, { autoRestart: true });
    if (result.success) {
      state.setIsStuck(false);
      state.setHasCheckedRunning(false);
    }
    state.setIsRecovering(false);
  };

  const handleReject = async () => {
    // Allow submission if there's text feedback OR images attached
    if (!state.feedback.trim() && state.feedbackImages.length === 0) {
      return;
    }
    state.setIsSubmitting(true);
    await submitReview(task.id, false, state.feedback, state.feedbackImages);
    state.setIsSubmitting(false);
    state.setFeedback('');
    state.setFeedbackImages([]);
  };

  const handleDelete = async () => {
    state.setIsDeleting(true);
    state.setDeleteError(null);
    const result = await deleteTask(task.id);
    if (result.success) {
      state.setShowDeleteDialog(false);
      onOpenChange(false);
    } else {
      state.setDeleteError(result.error || t('tasks:deleteDialog.failed'));
    }
    state.setIsDeleting(false);
  };

  const handleMerge = async () => {
    state.setIsMerging(true);
    state.setWorkspaceError(null);
    try {
      const result = await window.electronAPI.mergeWorktree(task.id, { noCommit: state.stageOnly });
      if (result.success && result.data?.success) {
        if (state.stageOnly && result.data.staged) {
          state.setWorkspaceError(null);
          state.setStagedSuccess(result.data.message || 'Changes staged in main project');
          state.setStagedProjectPath(result.data.projectPath);
          state.setSuggestedCommitMessage(result.data.suggestedCommitMessage);
        } else {
          onOpenChange(false);
        }
      } else {
        state.setWorkspaceError(result.data?.message || result.error || 'Failed to merge changes');
      }
    } catch (error) {
      state.setWorkspaceError(error instanceof Error ? error.message : 'Unknown error during merge');
    } finally {
      state.setIsMerging(false);
    }
  };

  const handleDiscard = async () => {
    state.setIsDiscarding(true);
    state.setWorkspaceError(null);
    const result = await window.electronAPI.discardWorktree(task.id);
    if (result.success && result.data?.success) {
      state.setShowDiscardDialog(false);
      onOpenChange(false);
    } else {
      state.setWorkspaceError(result.data?.message || result.error || 'Failed to discard changes');
    }
    state.setIsDiscarding(false);
  };

  const handleCreatePR = async (options: WorktreeCreatePROptions) => {
    state.setIsCreatingPR(true);
    try {
      const result = await window.electronAPI.createWorktreePR(task.id, options);
      if (result.success && result.data) {
        // Update single task in store with new status and prUrl (more efficient than reloading all tasks)
        if (result.data.success && result.data.prUrl && !result.data.alreadyExists) {
          useTaskStore.getState().updateTask(task.id, {
            status: 'done',
            metadata: { ...task.metadata, prUrl: result.data.prUrl }
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

  const handleClose = () => {
    // Show toast notification if task is running
    if (state.isRunning && !state.isStuck) {
      toast({
        title: t('tasks:notifications.backgroundTaskTitle'),
        description: t('tasks:notifications.backgroundTaskDescription'),
        duration: 4000,
      });
    }
    onOpenChange(false);
  };

  // Helper function to get status badge variant
  const getStatusBadgeVariant = (status: string, isStuck: boolean) => {
    if (isStuck) return 'warning';
    switch (status) {
      case 'done':
        return 'success';
      case 'human_review':
        return 'purple';
      case 'in_progress':
        return 'info';
      default:
        return 'secondary';
    }
  };



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
            {/* pr-32 keeps the title clear of the header action buttons */}
            <div className="relative shrink-0 px-6 pb-4 pr-32 pt-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <DialogPrimitive.Title className={cn(DIALOG_TITLE_CLASS, 'truncate')}>
                    {task.title}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description asChild>
                    <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs font-mono">
                        {task.specId}
                      </Badge>
                      {state.isStuck ? (
                        <Badge variant="warning" className="text-xs flex items-center gap-1 animate-pulse">
                          <AlertTriangle className="h-3 w-3" />
                          {t('tasks:detailHeader.stuck')}
                        </Badge>
                      ) : state.isIncomplete ? (
                        <Badge variant="warning" className="text-xs flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            {t('tasks:detailHeader.incomplete')}
                          </Badge>
                      ) : (
                        <>
                           <Badge
                             variant={getStatusBadgeVariant(task.status, state.isStuck)}
                             className={cn('text-xs', (task.status === 'in_progress' && !state.isStuck) && 'status-running')}
                           >
                             {t(TASK_STATUS_LABELS[task.status])}
                           </Badge>
                          {task.status === 'human_review' && task.reviewReason && (
                            <Badge
                              variant={task.reviewReason === 'completed' ? 'success' : task.reviewReason === 'errors' ? 'destructive' : 'warning'}
                              className="text-xs"
                            >
                              {t(`tasks:detailHeader.reviewReason.${
                                task.reviewReason === 'completed' || task.reviewReason === 'errors' ||
                                task.reviewReason === 'plan_review' || task.reviewReason === 'stopped'
                                  ? task.reviewReason
                                  : 'qa'
                              }`)}
                            </Badge>
                          )}
                        </>
                      )}
                      {/* Compact progress indicator */}
                      {totalSubtasks > 0 && (
                        <span className="text-xs text-muted-foreground ml-1">
                          {t('tasks:detailHeader.subtaskProgress', { completed: completedSubtasks, total: totalSubtasks })}
                        </span>
                      )}
                    </div>
                  </DialogPrimitive.Description>
                  {window.DEBUG && (
                    <div className="mt-1 text-[11px] text-muted-foreground font-mono">
                      status={task.status} reviewReason={task.reviewReason ?? 'none'} phase={task.executionProgress?.phase ?? 'none'} reviewRequired={task.metadata?.requireReviewBeforeCoding ? 'true' : 'false'}
                      <br />
                      projectId={activeProject?.id ?? 'none'} projectName={activeProject?.name ?? 'none'}
                    </div>
                  )}
                </div>
                <div className="absolute right-3 top-3 z-10 flex items-center gap-1 electron-no-drag">
                  {task.metadata?.archivedAt && (
                    <button
                      type="button"
                      className={cn(DIALOG_CLOSE_BUTTON_CLASS, 'static')}
                      onClick={handleUnarchive}
                      disabled={isUnarchiving}
                      title={t('tasks:actions.unarchive')}
                      aria-label={t('tasks:actions.unarchive')}
                    >
                      {isUnarchiving ? (
                        <Loader2 className={cn(DIALOG_CLOSE_ICON_CLASS, 'animate-spin')} />
                      ) : (
                        <ArchiveRestore className={DIALOG_CLOSE_ICON_CLASS} strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className={cn(DIALOG_CLOSE_BUTTON_CLASS, 'static hover:bg-destructive/10 hover:text-destructive')}
                    onClick={() => state.setShowDeleteDialog(true)}
                    disabled={state.isRunning && !state.isStuck}
                    title={t('tasks:actions.delete')}
                    aria-label={t('tasks:actions.delete')}
                  >
                    <Trash2 className={DIALOG_CLOSE_ICON_CLASS} strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  </button>
                  <button
                    type="button"
                    className={cn(DIALOG_CLOSE_BUTTON_CLASS, 'static')}
                    onClick={() => state.setIsEditDialogOpen(true)}
                    disabled={state.isRunning && !state.isStuck}
                    title={t('tasks:kanban.editTask')}
                    aria-label={t('tasks:kanban.editTask')}
                  >
                    <Pencil className={DIALOG_CLOSE_ICON_CLASS} strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  </button>
                  <DialogPrimitive.Close
                    className={cn(DIALOG_CLOSE_BUTTON_CLASS, 'static')}
                    aria-label={t('common:buttons.close')}
                  >
                    <X className={DIALOG_CLOSE_ICON_CLASS} strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  </DialogPrimitive.Close>
                </div>
              </div>


              {/* Warnings - compact inline */}
              {(state.isStuck || state.isIncomplete) && (
                <div className="mt-3">
                  <TaskWarnings
                    isStuck={state.isStuck}
                    isIncomplete={state.isIncomplete}
                    isRecovering={state.isRecovering}
                    taskProgress={state.taskProgress}
                    onRecover={handleRecover}
                    onResume={handleStartStop}
                  />
                </div>
              )}
            </div>

            {/* Body - Single Column with Tabs */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <Tabs value={state.activeTab} onValueChange={state.setActiveTab} className="flex flex-col h-full">
                {/* Tabs as a segmented control, like the settings dialog */}
                <div className="shrink-0 px-6 pb-3">
                  <SegmentedControl
                    value={state.activeTab}
                    onValueChange={state.setActiveTab}
                    ariaLabel={t('tasks:detailTabs.label')}
                    options={[
                      { value: 'overview', label: t('tasks:detailTabs.overview') },
                      { value: 'subtasks', label: t('tasks:detailTabs.subtasks', { count: task.subtasks.length }) },
                      { value: 'logs', label: t('tasks:detailTabs.logs') }
                    ]}
                  />
                </div>

                {/* Overview Tab */}
                <TabsContent value="overview" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <ScrollArea className="h-full">
                    <div className="p-6 space-y-5 overflow-x-hidden max-w-full">
                      {/* Metadata */}
                      <TaskMetadata task={task} />

                      {/* Human Review Section */}
                      {state.needsReview && (
                        <>
                          <Separator />
                          <TaskReview
                            task={task}
                            feedback={state.feedback}
                            isSubmitting={state.isSubmitting}
                            worktreeStatus={state.worktreeStatus}
                            worktreeDiff={state.worktreeDiff}
                            isLoadingWorktree={state.isLoadingWorktree}
                            isMerging={state.isMerging}
                            isDiscarding={state.isDiscarding}
                            showDiscardDialog={state.showDiscardDialog}
                            showDiffDialog={state.showDiffDialog}
                            workspaceError={state.workspaceError}
                            stageOnly={state.stageOnly}
                            stagedSuccess={state.stagedSuccess}
                            stagedProjectPath={state.stagedProjectPath}
                            suggestedCommitMessage={state.suggestedCommitMessage}
                            mergePreview={state.mergePreview}
                            isLoadingPreview={state.isLoadingPreview}
                            showConflictDialog={state.showConflictDialog}
                            onFeedbackChange={state.setFeedback}
                            onReject={handleReject}
                            images={state.feedbackImages}
                            onImagesChange={state.setFeedbackImages}
                            onMerge={handleMerge}
                            onDiscard={handleDiscard}
                            onShowDiscardDialog={state.setShowDiscardDialog}
                            onShowDiffDialog={state.setShowDiffDialog}
                            onStageOnlyChange={state.setStageOnly}
                            onShowConflictDialog={state.setShowConflictDialog}
                            onLoadMergePreview={state.loadMergePreview}
                            onClose={handleClose}
                            onSwitchToTerminals={onSwitchToTerminals}
                            onOpenInbuiltTerminal={onOpenInbuiltTerminal}
                            onReviewAgain={state.handleReviewAgain}
                            showPRDialog={state.showPRDialog}
                            isCreatingPR={state.isCreatingPR}
                            onShowPRDialog={state.setShowPRDialog}
                            onCreatePR={handleCreatePR}
                          />
                        </>
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* Subtasks Tab */}
                <TabsContent value="subtasks" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <TaskSubtasks task={task} />
                </TabsContent>

                {/* Logs Tab */}
                <TabsContent value="logs" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <TaskLogs
                    task={task}
                    phaseLogs={state.phaseLogs}
                    isLoadingLogs={state.isLoadingLogs}
                    expandedPhases={state.expandedPhases}
                    logsEndRef={state.logsEndRef}
                    logsContainerRef={state.logsContainerRef}
                    onLogsScroll={state.handleLogsScroll}
                    onTogglePhase={state.togglePhase}
                  />
                </TabsContent>

              </Tabs>
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
