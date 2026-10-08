import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  RefreshCw,
  PanelLeft
} from 'lucide-react';
import { AgentsIcon, InsightsIcon, KanbanIcon, ProjectIcon, SettingsIcon as Settings } from './icons/app-icons';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from './ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { cn } from '../lib/utils';
import {
  useProjectStore,
  removeProject,
  initializeProject
} from '../stores/project-store';
import { useSettingsStore, saveSettings } from '../stores/settings-store';
import { loadProjectEnvConfig, clearProjectEnvConfig } from '../stores/project-env-store';
import { AddProjectModal } from './AddProjectModal';
import { GitSetupModal } from './GitSetupModal';
import { RateLimitIndicator } from './RateLimitIndicator';

import { UpdateBanner } from './UpdateBanner';
import { UsageIndicator } from './UsageIndicator';
import { HeaderStatus } from './HeaderStatus';
import type { Project, GitStatus } from '../../shared/types';

export type SidebarView = 'projects' | 'kanban' | 'terminals' | 'insights';

interface SidebarProps {
  onSettingsClick: () => void;
  onNewTaskClick: () => void;
  activeView?: SidebarView;
  onViewChange?: (view: SidebarView) => void;
}

interface NavItem {
  id: SidebarView;
  labelKey: string;
  icon: React.ElementType;
}

// Main nav items
const navItems: NavItem[] = [
  { id: 'kanban', labelKey: 'navigation:items.kanban', icon: KanbanIcon },
  { id: 'terminals', labelKey: 'navigation:items.terminals', icon: AgentsIcon },
  { id: 'insights', labelKey: 'navigation:items.insights', icon: InsightsIcon },
];


export function Sidebar({
  onSettingsClick,
  onNewTaskClick,
  activeView = 'kanban',
  onViewChange
}: SidebarProps) {
  const { t } = useTranslation(['navigation', 'dialogs', 'common']);

  const projects = useProjectStore((state) => state.projects);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const storeSelectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectedProjectId = activeProjectId ?? storeSelectedProjectId;
  const settings = useSettingsStore((state) => state.settings);

  const [showAddProjectModal, setShowAddProjectModal] = useState(false);
  const [showInitDialog, setShowInitDialog] = useState(false);
  const [showGitSetupModal, setShowGitSetupModal] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [pendingProject, setPendingProject] = useState<Project | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  // Sidebar collapsed state from settings
  const isCollapsed = settings.sidebarCollapsed ?? false;

  const toggleSidebar = () => {
    saveSettings({ sidebarCollapsed: !isCollapsed });
  };

  // Track the last loaded project ID to avoid redundant loads
  const lastLoadedProjectIdRef = useRef<string | null>(null);

  // Load envConfig when project changes to ensure store is populated
  useEffect(() => {
    // Track whether this effect is still current (for race condition handling)
    let isCurrent = true;

    const initializeEnvConfig = async () => {
      if (selectedProject?.id && selectedProject?.autoBuildPath) {
        // Only reload if the project ID differs from what we last loaded
        if (selectedProject.id !== lastLoadedProjectIdRef.current) {
          lastLoadedProjectIdRef.current = selectedProject.id;
          await loadProjectEnvConfig(selectedProject.id);
          // Check if this effect was cancelled while loading
          if (!isCurrent) return;
        }
      } else {
        // Clear the store if no project is selected or has no autoBuildPath
        lastLoadedProjectIdRef.current = null;
        clearProjectEnvConfig();
      }
    };
    initializeEnvConfig();

    // Cleanup function to mark this effect as stale
    return () => {
      isCurrent = false;
    };
  }, [selectedProject?.id, selectedProject?.autoBuildPath]);

  // Check git status when project changes
  useEffect(() => {
    const checkGit = async () => {
      if (selectedProject) {
        try {
          const result = await window.electronAPI.checkGitStatus(selectedProject.path);
          if (result.success && result.data) {
            setGitStatus(result.data);
            // Show git setup modal if project is not a git repo or has no commits
            if (!result.data.isGitRepo || !result.data.hasCommits) {
              setShowGitSetupModal(true);
            }
          }
        } catch (error) {
          console.error('Failed to check git status:', error);
        }
      } else {
        setGitStatus(null);
      }
    };
    checkGit();
  }, [selectedProject]);

  const handleProjectAdded = (project: Project, needsInit: boolean) => {
    if (needsInit) {
      setPendingProject(project);
      setShowInitDialog(true);
    }
  };

  const handleInitialize = async () => {
    if (!pendingProject) return;

    const projectId = pendingProject.id;
    setIsInitializing(true);
    try {
      const result = await initializeProject(projectId);
      if (result?.success) {
        // Clear pendingProject FIRST before closing dialog
        // This prevents onOpenChange from triggering skip logic
        setPendingProject(null);
        setShowInitDialog(false);
      }
    } finally {
      setIsInitializing(false);
    }
  };

  const handleSkipInit = () => {
    setShowInitDialog(false);
    setPendingProject(null);
  };

  const handleGitInitialized = async () => {
    // Refresh git status after initialization
    if (selectedProject) {
      try {
        const result = await window.electronAPI.checkGitStatus(selectedProject.path);
        if (result.success && result.data) {
          setGitStatus(result.data);
        }
      } catch (error) {
        console.error('Failed to refresh git status:', error);
      }
    }
  };

  const _handleRemoveProject = async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    await removeProject(projectId);
  };


  const handleNavClick = (view: SidebarView) => {
    onViewChange?.(view);
  };

  // Row geometry mirrors the claude.ai sidebar: 32px rows, 8px radius, 28px icon slot
  const rowClass = (isActive = false) => cn(
    'group flex h-8 w-full items-center rounded-(--nav-item-radius) text-sm text-muted-foreground',
    'transition-colors duration-150 ease-out',
    'hover:bg-nav-hover hover:text-nav-hover-foreground',
    'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
    'disabled:pointer-events-none disabled:opacity-50',
    isActive && 'bg-nav-active text-nav-active-foreground hover:bg-nav-active hover:text-nav-active-foreground',
    isCollapsed ? 'justify-center' : 'gap-(--nav-item-gap) px-0.5'
  );

  const renderRowIcon = (Icon: React.ElementType) => (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center">
      <Icon className="h-[1.125rem] w-[1.125rem]" strokeWidth={1.75} />
    </span>
  );

  const withCollapsedTooltip = (key: string, label: string, node: React.ReactElement) => {
    if (!isCollapsed) return node;
    return (
      <Tooltip key={key}>
        <TooltipTrigger asChild>{node}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  };

  const renderNavItem = (item: NavItem) => {
    const isActive = activeView === item.id;
    const label = t(item.labelKey);

    const button = (
      <button
        key={item.id}
        type="button"
        onClick={() => handleNavClick(item.id)}
        // Kanban stays available without a project: it hosts the welcome page
        disabled={!selectedProjectId && item.id !== 'kanban'}
        aria-current={isActive ? 'page' : undefined}
        className={rowClass(isActive)}
      >
        {renderRowIcon(item.icon)}
        {!isCollapsed && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      </button>
    );

    return withCollapsedTooltip(item.id, label, button);
  };

  const newTaskDisabled = !selectedProjectId || !selectedProject?.autoBuildPath;
  // The Projects row shows the active project's name (falls back to "Projects")
  const projectsLabel = selectedProject?.name ?? t('items.projects');


  return (
    <TooltipProvider>
      <aside className={cn(
        'flex h-full shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground',
        'transition-[width] duration-300 ease-[cubic-bezier(.32,.72,0,1)]',
        isCollapsed ? 'w-14' : 'w-72'
      )}>
        {/* Header: drag area (extra top padding clears the macOS traffic lights) with toggle + wordmark */}
        <div className={cn(
          'electron-drag flex h-14 shrink-0 items-center gap-1 pt-6',
          isCollapsed ? 'justify-center px-2' : 'px-2'
        )}>
          {/* No hover tooltip; the label stays available to screen readers */}
          <Button
            variant="ghost"
            size="icon"
            className="electron-no-drag h-8 w-8 text-muted-foreground hover:bg-nav-hover hover:text-foreground"
            onClick={toggleSidebar}
            aria-label={isCollapsed ? t('actions.expandSidebar') : t('actions.collapseSidebar')}
          >
            <PanelLeft className="h-[1.125rem] w-[1.125rem]" strokeWidth={1.75} />
          </Button>
          {!isCollapsed && (
            <span className="electron-no-drag ml-1.5 flex min-w-0 items-center">
              <HeaderStatus />
            </span>
          )}
        </div>

        <div className="shrink-0 px-2 pt-3">
          {/* Projects page, labelled with the active project's name */}
          {withCollapsedTooltip('projects', projectsLabel, (
            <button
              type="button"
              onClick={() => handleNavClick('projects')}
              // Nothing to pick until a project has been added (the welcome page lives under Kanban)
              disabled={projects.length === 0}
              aria-current={activeView === 'projects' ? 'page' : undefined}
              className={rowClass(activeView === 'projects')}
            >
              {renderRowIcon(ProjectIcon)}
              {!isCollapsed && <span className="min-w-0 flex-1 truncate text-left">{projectsLabel}</span>}
            </button>
          ))}

          {/* Primary action, like claude.ai's "New" */}
          {withCollapsedTooltip('new-task', t('actions.newTask'), (
            <button
              type="button"
              onClick={onNewTaskClick}
              disabled={newTaskDisabled}
              className={cn(rowClass(), 'text-foreground')}
            >
              {renderRowIcon(Plus)}
              {!isCollapsed && <span className="min-w-0 flex-1 truncate text-left">{t('actions.newTask')}</span>}
            </button>
          ))}
          {!isCollapsed && selectedProject && !selectedProject.autoBuildPath && (
            <p className="px-2 pt-1 text-xs text-(--nav-label-color)">
              {t('messages.initializeToCreateTasks')}
            </p>
          )}
        </div>

        {/* Navigation */}
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-2 pb-2 pt-4">
            {!isCollapsed && (
              <h3 className="nav-section-label flex h-8 items-center px-2 text-[0.8125rem]">
                {t('sections.project')}
              </h3>
            )}
            <nav className="flex flex-col gap-px">
              {navItems.map(renderNavItem)}
            </nav>
          </div>
        </ScrollArea>

        {/* Rate Limit Indicator - shows when Claude is rate limited */}
        <RateLimitIndicator />

        {/* Update Banner - shows when app update is available */}
        <UpdateBanner />

        {/* Footer: settings with account + usage status beside it */}
        <div className={cn(
          'flex shrink-0 border-t border-border px-2 py-2',
          isCollapsed ? 'flex-col items-center gap-1' : 'items-center gap-1'
        )}>
          {withCollapsedTooltip('settings', t('tooltips.settings'), (
            <button type="button" onClick={onSettingsClick} className={cn(rowClass(), !isCollapsed && 'min-w-0 flex-1')}>
              {renderRowIcon(Settings)}
              {!isCollapsed && <span className="min-w-0 flex-1 truncate text-left">{t('actions.settings')}</span>}
            </button>
          ))}
          {!isCollapsed && <UsageIndicator />}
        </div>
      </aside>

      {/* Initialize Auto Claude Dialog */}
      <Dialog open={showInitDialog} onOpenChange={(open) => {
        // Only allow closing if user manually closes (not during initialization)
        if (!open && !isInitializing) {
          handleSkipInit();
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('dialogs:initialize.title')}
            </DialogTitle>
            <DialogDescription>
              {t('dialogs:initialize.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
              <p className="text-foreground mb-2">{t('dialogs:initialize.willDo')}</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>{t('dialogs:initialize.createFolder')}</li>
                <li>{t('dialogs:initialize.copyFramework')}</li>
                <li>{t('dialogs:initialize.setupSpecs')}</li>
              </ul>
            </div>
            {!settings.autoBuildPath && (
              <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
                <p className="text-foreground">{t('dialogs:initialize.sourcePathNotConfigured')}</p>
                <p className="text-muted-foreground mt-1">
                  {t('dialogs:initialize.sourcePathNotConfiguredDescription')}
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={handleSkipInit} disabled={isInitializing}>
              {t('common:buttons.skip')}
            </Button>
            <Button
              size="sm"
              onClick={handleInitialize}
              disabled={isInitializing || !settings.autoBuildPath}
            >
              {isInitializing ? (
                <>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('common:labels.initializing')}
                </>
              ) : (
                t('common:buttons.initialize')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Project Modal */}
      <AddProjectModal
        open={showAddProjectModal}
        onOpenChange={setShowAddProjectModal}
        onProjectAdded={handleProjectAdded}
      />

      {/* Git Setup Modal */}
      <GitSetupModal
        open={showGitSetupModal}
        onOpenChange={setShowGitSetupModal}
        project={selectedProject || null}
        gitStatus={gitStatus}
        onGitInitialized={handleGitInitialized}
      />
    </TooltipProvider>
  );
}
