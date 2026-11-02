/**
 * TaskEditDialog - Dialog for editing task details
 *
 * Edits the task's description, reference images, MCP connectors and git options - the base
 * branch and whether its branch is pushed (the title is kept). Model, effort and planning are
 * decided by the Claude Code triage run when the task starts.
 *
 * The base branch is the one the task's next run starts from, and the branch its changes are
 * counted and merged against, so a task created with a branch that no longer exists can be
 * pointed at one that does.
 *
 * Uses the shared TaskModalLayout and TaskFormFields (same look as the creation dialog) and
 * saves via persistUpdateTask (updates store + spec files). Closes without saving when nothing
 * changed.
 */
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { TaskModalLayout } from './task-form/TaskModalLayout';
import { TaskFormFields } from './task-form/TaskFormFields';
import { PROJECT_DEFAULT_BRANCH, TaskGitOptionsSection, useTaskGitOptions } from './task-form/TaskGitOptions';
import { persistUpdateTask } from '../stores/task-store';
import { useProjectStore } from '../stores/project-store';
import type { Task, TaskMetadata, ImageAttachment } from '../../shared/types';
import { useSettingsStore } from '../stores/settings-store';
import { getDefaultMcpConnectorIds } from '../../shared/utils/mcp-connectors';
import type { PuppeteerBrowserChoice } from '../../shared/types/browser-profiles';

/**
 * Props for the TaskEditDialog component
 */
interface TaskEditDialogProps {
  /** The task to edit */
  task: Task;
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when the dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** Optional callback when task is successfully saved */
  onSaved?: () => void;
}

export function TaskEditDialog({ task, open, onOpenChange, onSaved }: TaskEditDialogProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { settings } = useSettingsStore();

  // Get project path for loading image thumbnails from disk
  const projects = useProjectStore((state) => state.projects);
  const projectPath = useMemo(() => {
    const project = projects.find(p => p.id === task.projectId);
    return project?.path;
  }, [projects, task.projectId]);

  // Form state
  const [description, setDescription] = useState(task.description);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Image attachments
  const [images, setImages] = useState<ImageAttachment[]>(task.metadata?.attachedImages || []);

  // MCP connectors: the task's own choice, or the Connectors defaults for tasks created before
  // connectors were per task. Saving changes only this task
  const taskConnectors = task.metadata?.mcpConnectors ?? getDefaultMcpConnectorIds(settings.mcpConnectors);
  const [mcpConnectors, setMcpConnectors] = useState<string[]>(taskConnectors);
  // The Puppeteer connector's browser profile picked for the task; unset follows Settings > Connectors
  const [puppeteerBrowser, setPuppeteerBrowser] = useState<PuppeteerBrowserChoice | null | undefined>(task.metadata?.puppeteerBrowser);

  // Git options: the task's own base branch, listed even when the project no longer has it, and
  // whether its branch is pushed (unset follows the project's own setting)
  const taskBaseBranch = task.metadata?.baseBranch || PROJECT_DEFAULT_BRANCH;
  const gitOptions = useTaskGitOptions(task.projectId, taskBaseBranch);
  const taskPushNewBranches = task.metadata?.pushNewBranches ?? gitOptions.projectPushNewBranches;
  const [baseBranch, setBaseBranch] = useState(taskBaseBranch);
  const [pushNewBranches, setPushNewBranches] = useState(taskPushNewBranches);

  // Reset form when task changes or dialog opens
  useEffect(() => {
    if (open) {
      setDescription(task.description);
      setImages(task.metadata?.attachedImages || []);
      setMcpConnectors(task.metadata?.mcpConnectors ?? getDefaultMcpConnectorIds(settings.mcpConnectors));
      setPuppeteerBrowser(task.metadata?.puppeteerBrowser);
      setBaseBranch(task.metadata?.baseBranch || PROJECT_DEFAULT_BRANCH);
      setPushNewBranches(task.metadata?.pushNewBranches ?? gitOptions.projectPushNewBranches);
      setError(null);
    }
  }, [open, task, settings.mcpConnectors, gitOptions.projectPushNewBranches]);

  const handleSave = async () => {
    // Validate input
    if (!description.trim()) {
      setError(t('tasks:form.errors.descriptionRequired'));
      return;
    }

    // Check if anything changed
    const trimmedDescription = description.trim();
    const hasChanges =
      trimmedDescription !== task.description ||
      [...mcpConnectors].sort().join(',') !== [...taskConnectors].sort().join(',') ||
      JSON.stringify(puppeteerBrowser) !== JSON.stringify(task.metadata?.puppeteerBrowser) ||
      baseBranch !== taskBaseBranch ||
      pushNewBranches !== taskPushNewBranches ||
      JSON.stringify(images) !== JSON.stringify(task.metadata?.attachedImages || []);

    if (!hasChanges) {
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    setError(null);

    // The project default is stored as the branch it stands for, like the creation dialog does,
    // so every later run and diff reads one branch name. `undefined` clears the stored field.
    const resolvedBaseBranch = baseBranch === PROJECT_DEFAULT_BRANCH
      ? gitOptions.projectDefaultBranch || undefined
      : baseBranch || undefined;
    // A local branch is started from as it is, which keeps gitignored files (.env, configs) out
    // of harm's way. Read again only when the branch changed, so the task's own flag survives a
    // save made before the branch list is there
    const useLocalBranch = baseBranch === taskBaseBranch
      ? task.metadata?.useLocalBranch
      : (!!resolvedBaseBranch && gitOptions.isLocalBranch(resolvedBaseBranch)) || undefined;

    const metadataUpdates: Partial<TaskMetadata> = {
      // Always set attachedImages to persist removal when all images are deleted
      attachedImages: images,
      mcpConnectors,
      // Only once a browser was picked for the task: until then it follows Settings
      ...(puppeteerBrowser !== undefined ? { puppeteerBrowser } : {}),
      baseBranch: resolvedBaseBranch,
      useLocalBranch,
      // Unset again when it matches the project's own setting, so the task follows it
      pushNewBranches: pushNewBranches === gitOptions.projectPushNewBranches ? undefined : pushNewBranches
    };

    const success = await persistUpdateTask(
      task.id,
      { description: trimmedDescription, metadata: metadataUpdates },
      task.projectId
    );

    if (success) {
      onOpenChange(false);
      onSaved?.();
    } else {
      setError(t('tasks:edit.errors.updateFailed'));
    }

    setIsSaving(false);
  };

  const isValid = description.trim().length > 0;

  return (
    <TaskModalLayout
      open={open}
      onOpenChange={onOpenChange}
      title={t('tasks:edit.title')}
      description={t('tasks:edit.description')}
      disabled={isSaving}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('common:buttons.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving || !isValid}>
            {isSaving ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('common:buttons.saving')}
              </>
            ) : (
              t('tasks:edit.saveChanges')
            )}
          </Button>
        </div>
      }
    >
      <TaskFormFields
        projectPath={projectPath}
        specId={task.specId}
        description={description}
        onDescriptionChange={setDescription}
        images={images}
        onImagesChange={setImages}
        mcpConnectors={mcpConnectors}
        onMcpConnectorsChange={setMcpConnectors}
        puppeteerBrowser={puppeteerBrowser}
        onPuppeteerBrowserChange={setPuppeteerBrowser}
        disabled={isSaving}
        error={error}
        onError={setError}
        idPrefix="edit"
        extraSections={
          <TaskGitOptionsSection
            options={gitOptions}
            baseBranch={baseBranch}
            onBaseBranchChange={setBaseBranch}
            pushNewBranches={pushNewBranches}
            onPushNewBranchesChange={setPushNewBranches}
            disabled={isSaving}
            idPrefix="edit"
          />
        }
      />
    </TaskModalLayout>
  );
}
