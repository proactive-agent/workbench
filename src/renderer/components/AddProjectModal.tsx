import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, FolderPlus, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { SettingsRow } from './settings/SettingsRow';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { cn } from '../lib/utils';
import { addProject } from '../stores/project-store';
import type { Project } from '../../shared/types';

export type AddProjectModalStep = 'choose' | 'create-form';
type ModalStep = AddProjectModalStep;

/**
 * Let the user pick an existing folder and add it as a project (auto-detecting its main branch).
 * Returns the added project, or null when the picker is cancelled.
 */
export async function pickAndAddExistingProject(): Promise<Project | null> {
  const path = await window.electronAPI.selectDirectory();
  if (!path) return null;
  const project = await addProject(path);
  if (!project) return null;
  // Auto-detect and save the main branch for the project
  try {
    const mainBranchResult = await window.electronAPI.detectMainBranch(path);
    if (mainBranchResult.success && mainBranchResult.data) {
      await window.electronAPI.updateProjectSettings(project.id, {
        mainBranch: mainBranchResult.data
      });
    }
  } catch {
    // Non-fatal - main branch can be set later in settings
  }
  return project;
}

interface AddProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectAdded?: (project: Project, needsInit: boolean) => void;
  /** Step to open on; 'create-form' skips the choice (its back button then cancels) */
  initialStep?: AddProjectModalStep;
}

export function AddProjectModal({ open, onOpenChange, onProjectAdded, initialStep = 'choose' }: AddProjectModalProps) {
  const { t } = useTranslation('dialogs');
  const [step, setStep] = useState<ModalStep>('choose');
  const [projectName, setProjectName] = useState('');
  const [projectLocation, setProjectLocation] = useState('');
  const [initGit, setInitGit] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setStep(initialStep);
      setProjectName('');
      setProjectLocation('');
      setInitGit(true);
      setError(null);
    }
  }, [open, initialStep]);

  // Load default location on mount
  useEffect(() => {
    const loadDefaultLocation = async () => {
      try {
        const defaultDir = await window.electronAPI.getDefaultProjectLocation();
        if (defaultDir) {
          setProjectLocation(defaultDir);
        }
      } catch {
        // Ignore - will just be empty
      }
    };
    loadDefaultLocation();
  }, []);

  const handleOpenExisting = async () => {
    try {
      const project = await pickAndAddExistingProject();
      if (project) {
        onProjectAdded?.(project, !project.autoBuildPath);
        onOpenChange(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('addProject.failedToOpen'));
    }
  };

  const handleSelectLocation = async () => {
    try {
      const path = await window.electronAPI.selectDirectory();
      if (path) {
        setProjectLocation(path);
      }
    } catch {
      // User cancelled - ignore
    }
  };

  const handleCreateProject = async () => {
    if (!projectName.trim()) {
      setError(t('addProject.nameRequired'));
      return;
    }
    if (!projectLocation.trim()) {
      setError(t('addProject.locationRequired'));
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // Create the project folder
      const result = await window.electronAPI.createProjectFolder(
        projectLocation,
        projectName.trim(),
        initGit
      );

      if (!result.success || !result.data) {
        setError(result.error || 'Failed to create project folder');
        return;
      }

      // Add the project to our store
      const project = await addProject(result.data.path);
      if (project) {
        // For new projects with git init, set main branch
        // Git init creates 'main' branch by default on modern git
        if (initGit) {
          try {
            const mainBranchResult = await window.electronAPI.detectMainBranch(result.data.path);
            if (mainBranchResult.success && mainBranchResult.data) {
              await window.electronAPI.updateProjectSettings(project.id, {
                mainBranch: mainBranchResult.data
              });
            }
          } catch {
            // Non-fatal - main branch can be set later in settings
          }
        }
        onProjectAdded?.(project, true); // New projects always need init
        onOpenChange(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('addProject.failedToCreate'));
    } finally {
      setIsCreating(false);
    }
  };

  const renderChooseOption = (
    Icon: typeof FolderOpen,
    title: string,
    description: string,
    ariaLabel: string,
    onClick: () => void
  ) => (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-3 rounded-lg',
        'hover:bg-nav-hover transition-colors',
        'text-left group'
      )}
      aria-label={ariaLabel}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground">{title}</div>
        <div className="text-sm text-(--nav-label-color)">{description}</div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" strokeWidth={1.75} />
    </button>
  );

  const renderChooseStep = () => (
    <>
      <DialogHeader>
        <DialogTitle>{t('addProject.title')}</DialogTitle>
        <DialogDescription>
          {t('addProject.description')}
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-3 pt-4 space-y-1">
        {renderChooseOption(
          FolderOpen,
          t('addProject.openExisting'),
          t('addProject.openExistingDescription'),
          t('addProject.openExistingAriaLabel'),
          handleOpenExisting
        )}
        {renderChooseOption(
          FolderPlus,
          t('addProject.createNew'),
          t('addProject.createNewDescription'),
          t('addProject.createNewAriaLabel'),
          () => setStep('create-form')
        )}
      </div>

      {error && (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </>
  );

  const renderCreateForm = () => (
    <>
      <DialogHeader>
        <DialogTitle>{t('addProject.createNewTitle')}</DialogTitle>
        <DialogDescription>
          {t('addProject.createNewSubtitle')}
        </DialogDescription>
      </DialogHeader>

      <div className="pt-4 space-y-4">
        {/* Project name */}
        <div className="space-y-2">
          <Label htmlFor="project-name">{t('addProject.projectName')}</Label>
          <Input
            id="project-name"
            placeholder={t('addProject.projectNamePlaceholder')}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            autoFocus
          />
          <p className="text-sm text-(--nav-label-color)">
            {t('addProject.projectNameHelp')}
          </p>
        </div>

        {/* Location */}
        <div className="space-y-2">
          <Label htmlFor="project-location">{t('addProject.location')}</Label>
          <div className="flex gap-2">
            <Input
              id="project-location"
              placeholder={t('addProject.locationPlaceholder')}
              value={projectLocation}
              onChange={(e) => setProjectLocation(e.target.value)}
              className="flex-1"
            />
            <Button variant="outline" size="sm" onClick={handleSelectLocation}>
              {t('addProject.browse')}
            </Button>
          </div>
          {projectLocation && projectName && (
            <p className="text-sm text-(--nav-label-color) break-all">
              {t('addProject.willCreate')} <span className="font-mono text-foreground">{projectLocation}/{projectName}</span>
            </p>
          )}
        </div>

        {/* Git init */}
        <SettingsRow label={t('addProject.initGit')} htmlFor="init-git" className="pb-0">
          <Switch id="init-git" checked={initGit} onCheckedChange={setInitGit} />
        </SettingsRow>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      <DialogFooter>
        {initialStep === 'create-form' ? (
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isCreating}>
            {t('common:buttons.cancel')}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setStep('choose')} disabled={isCreating}>
            {t('addProject.back')}
          </Button>
        )}
        <Button size="sm" onClick={handleCreateProject} disabled={isCreating}>
          {isCreating ? t('addProject.creating') : t('addProject.createProject')}
        </Button>
      </DialogFooter>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {step === 'choose' ? renderChooseStep() : renderCreateForm()}
      </DialogContent>
    </Dialog>
  );
}
