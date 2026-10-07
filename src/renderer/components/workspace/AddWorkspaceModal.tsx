import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { SettingsRow, SettingsRows } from '../settings/SettingsRow';
import type { Project } from '../../../shared/types';

type ProjectRole = 'backend' | 'frontend' | 'mobile' | 'shared' | 'api' | 'worker' | 'other';

interface WorkspaceProject {
  projectId: string;
  role: ProjectRole;
}

interface Workspace {
  id: string;
  name: string;
  description?: string;
  projects?: WorkspaceProject[];
}

type IPCResult<T> = { success: boolean; data?: T; error?: string };

type WorkspaceApi = {
  createWorkspace: (
    name: string,
    description?: string,
    options?: { validationEnabled?: boolean; validationTriggers?: string[] }
  ) => Promise<IPCResult<Workspace>>;
  addProjectToWorkspace: (
    workspaceId: string,
    projectId: string,
    role: ProjectRole
  ) => Promise<IPCResult<Workspace>>;
  getWorkspace: (workspaceId: string) => Promise<IPCResult<Workspace>>;
};

interface AddWorkspaceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  onCreated: (workspace: Workspace) => void;
}

interface SelectedProject {
  projectId: string;
  role: ProjectRole;
}

const ROLE_OPTIONS: ProjectRole[] = ['backend', 'frontend', 'mobile', 'shared', 'api', 'worker', 'other'];

export function AddWorkspaceModal({
  open,
  onOpenChange,
  projects,
  onCreated,
}: AddWorkspaceModalProps) {
  const { t } = useTranslation(['dialogs', 'common']);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<SelectedProject[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableProjects = projects.filter(
    (p) => !selectedProjects.some((sp) => sp.projectId === p.id)
  );

  const handleAddProject = (projectId: string) => {
    setSelectedProjects((prev) => [
      ...prev,
      { projectId, role: 'other' as ProjectRole },
    ]);
  };

  const handleRemoveProject = (projectId: string) => {
    setSelectedProjects((prev) => prev.filter((p) => p.projectId !== projectId));
  };

  const handleRoleChange = (projectId: string, role: ProjectRole) => {
    setSelectedProjects((prev) =>
      prev.map((p) => (p.projectId === projectId ? { ...p, role } : p))
    );
  };

  const getProjectName = (projectId: string): string => {
    const project = projects.find((p) => p.id === projectId);
    return project?.name || projectId;
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(t('dialogs:addWorkspace.nameRequired'));
      return;
    }

    const workspaceApi = window.electronAPI as unknown as Partial<WorkspaceApi>;
    if (!workspaceApi.createWorkspace || !workspaceApi.addProjectToWorkspace || !workspaceApi.getWorkspace) {
      setError(t('dialogs:addWorkspace.apiUnavailable'));
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // Create the workspace
      const result = await workspaceApi.createWorkspace(
        name.trim(),
        description.trim() || undefined,
        {
          validationEnabled: true,
          validationTriggers: ['spec_creation', 'before_merge'],
        }
      );

      if (!result.success || !result.data) {
        throw new Error(result.error || t('dialogs:addWorkspace.createFailed'));
      }

      const workspace = result.data;

      // Add projects to the workspace
      for (const selected of selectedProjects) {
        await workspaceApi.addProjectToWorkspace(
          workspace.id,
          selected.projectId,
          selected.role
        );
      }

      // Reload the workspace with members
      const reloadResult = await workspaceApi.getWorkspace(workspace.id);
      const finalWorkspace = reloadResult.success && reloadResult.data ? reloadResult.data : workspace;

      onCreated(finalWorkspace);
      resetForm();
    } catch (err) {
      setError(String(err));
    } finally {
      setIsCreating(false);
    }
  };

  const resetForm = () => {
    setName('');
    setDescription('');
    setSelectedProjects([]);
    setError(null);
  };

  const handleClose = () => {
    resetForm();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {t('dialogs:addWorkspace.title')}
          </DialogTitle>
          <DialogDescription>
            {t('dialogs:addWorkspace.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 pt-4">
          {/* Name */}
          <div className="grid gap-2">
            <Label htmlFor="name">{t('dialogs:addWorkspace.name')}</Label>
            <Input
              id="name"
              placeholder={t('dialogs:addWorkspace.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Description */}
          <div className="grid gap-2">
            <Label htmlFor="description">{t('dialogs:addWorkspace.descriptionLabel')}</Label>
            <Textarea
              id="description"
              placeholder={t('dialogs:addWorkspace.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          {/* Add projects */}
          <div className="grid gap-2">
            <Label htmlFor="workspace-add-project">{t('dialogs:addWorkspace.projects')}</Label>
            {availableProjects.length > 0 ? (
              <Select onValueChange={handleAddProject}>
                <SelectTrigger id="workspace-add-project">
                  <SelectValue placeholder={t('dialogs:addWorkspace.addProject')} />
                </SelectTrigger>
                <SelectContent>
                  {availableProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                {selectedProjects.length > 0
                  ? t('dialogs:addWorkspace.allAdded')
                  : t('dialogs:addWorkspace.noProjects')}
              </p>
            )}
          </div>

          {/* Selected projects */}
          {selectedProjects.length > 0 && (
            <SettingsRows>
              {selectedProjects.map((selected) => (
                <SettingsRow key={selected.projectId} label={getProjectName(selected.projectId)}>
                  <Select
                    value={selected.role}
                    onValueChange={(value) =>
                      handleRoleChange(selected.projectId, value as ProjectRole)
                    }
                  >
                    <SelectTrigger aria-label={t('dialogs:addWorkspace.role')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLE_OPTIONS.map((role) => (
                        <SelectItem key={role} value={role}>
                          {t(`dialogs:addWorkspace.roles.${role}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={t('dialogs:addWorkspace.removeProject')}
                    onClick={() => handleRemoveProject(selected.projectId)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </SettingsRow>
              ))}
            </SettingsRows>
          )}

          {/* Error */}
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {t('common:buttons.cancel')}
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={isCreating || !name.trim()}>
            {isCreating ? t('dialogs:addWorkspace.creating') : t('dialogs:addWorkspace.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
