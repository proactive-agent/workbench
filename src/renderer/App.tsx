import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { debugLog } from '../shared/utils/debug-logger';
import { TooltipProvider } from './components/ui/tooltip';
import { Button } from './components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './components/ui/dialog';
import { Sidebar, type SidebarView } from './components/Sidebar';
import { MemoryGraph } from './components/memory/MemoryGraph';
import { useMemoryGraphStore } from './stores/memory-graph-store';
import { KanbanBoard } from './components/KanbanBoard';
import { TaskDetailModal } from './components/task-detail/TaskDetailModal';
import { TaskCreationWizard } from './components/TaskCreationWizard';
import { AppSettingsDialog, type AppSection } from './components/settings/AppSettings';
import type { ProjectSettingsSection } from './components/settings/ProjectSettingsContent';
import { TerminalGrid } from './components/TerminalGrid';
import { Insights } from './components/Insights';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ProjectsPage } from './components/ProjectsPage';
import { AuthFailureModal } from './components/AuthFailureModal';
import { AppUpdateNotification } from './components/AppUpdateNotification';
import { ProactiveSwapListener } from './components/ProactiveSwapListener';
import { useProjectStore, loadProjects, initializeProject, removeProject } from './stores/project-store';
import { useTaskStore, loadTasks } from './stores/task-store';
import { useSettingsStore, loadSettings, loadProfiles } from './stores/settings-store';
import { loadClaudeProfiles } from './stores/claude-profile-store';
import { useTerminalStore, restoreTerminalSessions } from './stores/terminal-store';
import { useIpcListeners } from './hooks/useIpc';
import { closeProjectWindow, openProjectWindow, useProjectWindows } from './hooks/useProjectWindows';
import { useTitleBarColors } from './hooks/useTitleBarColors';
import { useGlobalTerminalListeners } from './hooks/useGlobalTerminalListeners';
import { sanitizeColorTheme } from '../shared/constants';
import { IS_DEV_BUILD, TITLE_BAR_STRIP_HEIGHT } from './lib/title-bar';
import { DevBuildBar } from './components/DevBuildBar';
import type { Task, Project } from '../shared/types';
import { AddProjectModal, pickAndAddExistingProject, type AddProjectModalStep } from './components/AddProjectModal';
import { ViewStateProvider } from './contexts/ViewStateContext';
import { INTERFACE_FONT_STACKS } from './lib/font-options';


export function App() {
  // Load IPC listeners for real-time updates
  useIpcListeners();

  // Keep the Windows/Linux window controls in the theme's colors
  useTitleBarColors();

  // Load global terminal output listeners to buffer output across project switches
  // This ensures terminal output is captured even when the terminal component is not rendered
  useGlobalTerminalListeners();


  // Stores
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const getProjectTabs = useProjectStore((state) => state.getProjectTabs);
  const openProjectIds = useProjectStore((state) => state.openProjectIds);
  const openProjectTab = useProjectStore((state) => state.openProjectTab);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const tasks = useTaskStore((state) => state.tasks);
  const settings = useSettingsStore((state) => state.settings);

  // Keep the terminal limit in sync with the "Maximum windows" setting
  useEffect(() => {
    if (settings.maxTerminals !== undefined) {
      useTerminalStore.getState().setMaxTerminals(settings.maxTerminals);
    }
  }, [settings.maxTerminals]);

  // UI State
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [isNewTaskDialogOpen, setIsNewTaskDialogOpen] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<AppSection | undefined>(undefined);
  const [settingsFocusId, setSettingsFocusId] = useState<string | undefined>(undefined);
  const [settingsInitialProjectSection, setSettingsInitialProjectSection] = useState<ProjectSettingsSection | undefined>(undefined);
  const [activeView, setActiveView] = useState<SidebarView>('kanban');

  // Without projects the Projects page is unavailable; Kanban shows the welcome page instead
  useEffect(() => {
    if (projects.length === 0 && activeView === 'projects') {
      setActiveView('kanban');
    }
  }, [projects.length, activeView]);

  // The Memory view needs the project's memory graph: leave it when the project has none
  const memoryProjectId = useProjectStore((state) => state.activeProjectId ?? state.selectedProjectId);
  const memoryGraphAvailable = useMemoryGraphStore((state) =>
    memoryProjectId ? state.available[memoryProjectId] : undefined
  );
  useEffect(() => {
    if (activeView === 'memory' && memoryGraphAvailable === false) {
      setActiveView('kanban');
    }
  }, [activeView, memoryGraphAvailable]);
  const [isRefreshingTasks, setIsRefreshingTasks] = useState(false);

  // Initialize dialog state
  const [showInitDialog, setShowInitDialog] = useState(false);
  const [pendingProject, setPendingProject] = useState<Project | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [initSuccess, setInitSuccess] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [skippedInitProjectId, setSkippedInitProjectId] = useState<string | null>(null);
  const [showAddProjectModal, setShowAddProjectModal] = useState(false);

  // GitHub setup state (shown after Workbench init)

  // Project picked on the Projects page while it has no window yet: this window or a new one
  const [projectToOpen, setProjectToOpen] = useState<Project | null>(null);
  // A just-added project still to be set up: its initialize prompt waits for that answer
  const [projectToInitialize, setProjectToInitialize] = useState<Project | null>(null);

  // Remove project confirmation state
  const [showRemoveProjectDialog, setShowRemoveProjectDialog] = useState(false);
  const [removeProjectError, setRemoveProjectError] = useState<string | null>(null);
  const [projectToRemove, setProjectToRemove] = useState<Project | null>(null);

  // Get tabs and selected project
  const projectTabs = getProjectTabs();
  const selectedProject = projects.find((p) => p.id === (activeProjectId || selectedProjectId));

  // Initial load
  useEffect(() => {
    loadProjects();
    loadSettings();
    loadProfiles();
    loadClaudeProfiles();
  }, []);

  // Restore tab state and open tabs for loaded projects
  useEffect(() => {
    console.warn('[App] Tab restore useEffect triggered:', {
      projectsCount: projects.length,
      openProjectIds,
      activeProjectId,
      selectedProjectId,
      projectTabsCount: projectTabs.length,
      projectTabIds: projectTabs.map(p => p.id)
    });

    if (projects.length > 0) {
      // Check openProjectIds (persisted state) instead of projectTabs (computed)
      // to avoid race condition where projectTabs is empty before projects load
      if (openProjectIds.length === 0) {
        // No tabs persisted at all, open the first available project
        const projectToOpen = activeProjectId || selectedProjectId || projects[0].id;
        console.warn('[App] No tabs persisted, opening project:', projectToOpen);
        // Verify the project exists before opening
        if (projects.some(p => p.id === projectToOpen)) {
          openProjectTab(projectToOpen);
          setActiveProject(projectToOpen);
        } else {
          // Fallback to first project if stored IDs are invalid
          console.warn('[App] Project not found, falling back to first project:', projects[0].id);
          openProjectTab(projects[0].id);
          setActiveProject(projects[0].id);
        }
        return;
      }
      console.warn('[App] Tabs already persisted, checking active project');
      // If there's an active project but no tabs open for it, open a tab
      // Note: Use openProjectIds instead of projectTabs to avoid re-render loop
      // (projectTabs creates a new array on every render)
      if (activeProjectId && !openProjectIds.includes(activeProjectId)) {
        console.warn('[App] Active project has no tab, opening:', activeProjectId);
        openProjectTab(activeProjectId);
      }
      // If there's a selected project but no active project, make it active
      else if (selectedProjectId && !activeProjectId) {
        console.warn('[App] No active project, using selected:', selectedProjectId);
        setActiveProject(selectedProjectId);
        openProjectTab(selectedProjectId);
      } else {
        console.warn('[App] Tab state is valid, no action needed');
      }
    }
  }, [projects, activeProjectId, selectedProjectId, openProjectIds, openProjectTab, setActiveProject, projectTabs.length, projectTabs.map]);

  // The projects that have a window, so cards can offer "Quit window" and switching can
  // focus an open project instead of opening it twice
  const { projectIds: windowedProjectIds, count: windowCount } = useProjectWindows();

  // Tell the main process which project this window shows (tray menu, window lookups).
  // Waits for the projects to load: reporting "no project" first would clear the project a
  // new window was opened for.
  useEffect(() => {
    const projectId = activeProjectId ?? selectedProjectId ?? null;
    if (!projectId && projects.length === 0) return;
    window.electronAPI.reportWindowProject(projectId);
  }, [activeProjectId, selectedProjectId, projects.length]);

  const { t, i18n } = useTranslation('dialogs');

  // Sync spell check language with i18n language
  useEffect(() => {
    const syncSpellCheck = async () => {
      try {
        const result = await window.electronAPI.setSpellCheckLanguages(i18n.language);
        if (!result.success) {
          console.warn('[App] Failed to set spell check language:', result.error);
        }
      } catch (error) {
        console.warn('[App] Error syncing spell check language:', error);
      }
    };

    syncSpellCheck();
  }, [i18n.language]);

  // Listen for open-app-settings events (e.g., from project settings)
  useEffect(() => {
    // detail: a page, or { section, focusId } to also scroll to and focus a field on that page
    const handleOpenAppSettings = (event: Event) => {
      const detail = (event as CustomEvent<AppSection | { section: AppSection; focusId?: string }>).detail;
      const section = typeof detail === 'string' ? detail : detail?.section;
      if (section) {
        setSettingsInitialSection(section);
      }
      setSettingsFocusId(typeof detail === 'object' && detail ? detail.focusId : undefined);
      setIsSettingsDialogOpen(true);
    };

    window.addEventListener('open-app-settings', handleOpenAppSettings);
    return () => {
      window.removeEventListener('open-app-settings', handleOpenAppSettings);
    };
  }, []);

  // Listen for open-project-settings events (e.g., the Kanban board's Settings button)
  useEffect(() => {
    const handleOpenProjectSettings = (event: Event) => {
      const section = (event as CustomEvent<ProjectSettingsSection>).detail;
      if (section) {
        setSettingsInitialProjectSection(section);
      }
      setIsSettingsDialogOpen(true);
    };

    window.addEventListener('open-project-settings', handleOpenProjectSettings);
    return () => {
      window.removeEventListener('open-project-settings', handleOpenProjectSettings);
    };
  }, []);

  // Listen for app updates - auto-open settings to 'updates' section when update is ready
  useEffect(() => {
    // When an update is downloaded and ready to install, open settings to updates section.
    // The event reaches every project window, so only the one the user is in opens the
    // dialog; the others show the update notification like any other window would.
    const cleanupDownloaded = window.electronAPI.onAppUpdateDownloaded(() => {
      if (!document.hasFocus()) return;
      console.warn('[App] Update downloaded, opening settings to updates section');
      setSettingsInitialSection('updates');
      setIsSettingsDialogOpen(true);
    });

    return () => {
      cleanupDownloaded();
    };
  }, []);

  // Reset init success flag when selected project changes
  // This allows the init dialog to show for new/different projects
  useEffect(() => {
    setInitSuccess(false);
    setInitError(null);
  }, []);

  // Check if selected project needs initialization (e.g., .workbench folder was deleted)
  useEffect(() => {
    // Don't show dialog while initialization is in progress
    if (isInitializing) return;

    // Don't reopen dialog after successful initialization
    // (project update with autoBuildPath may not have propagated yet)
    if (initSuccess) return;

    if (selectedProject && !selectedProject.autoBuildPath && skippedInitProjectId !== selectedProject.id) {
      // Project exists but isn't initialized - show init dialog
      setPendingProject(selectedProject);
      setInitError(null); // Clear any previous errors
      setInitSuccess(false); // Reset success flag
      setShowInitDialog(true);
    }
  }, [selectedProject, skippedInitProjectId, isInitializing, initSuccess]);

  // Load tasks when project changes
  useEffect(() => {
    const currentProjectId = activeProjectId || selectedProjectId;
    if (currentProjectId) {
      loadTasks(currentProjectId);
      setSelectedTask(null); // Clear selection on project change
    } else {
      useTaskStore.getState().clearTasks();
    }

    // Handle terminals on project change - DON'T destroy, just restore if needed
    // Terminals are now filtered by projectPath in TerminalGrid, so each project
    // sees only its own terminals. PTY processes stay alive across project switches.
    if (selectedProject?.path) {
      restoreTerminalSessions(selectedProject.path).catch((err) => {
        console.error('[App] Failed to restore sessions:', err);
      });
    }
  }, [activeProjectId, selectedProjectId, selectedProject?.path]);

  // Apply theme on load
  useEffect(() => {
    const root = document.documentElement;

    const applyTheme = () => {
      // Apply light/dark mode
      if (settings.theme === 'dark') {
        root.classList.add('dark');
      } else if (settings.theme === 'light') {
        root.classList.remove('dark');
      } else {
        // System preference
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
          root.classList.add('dark');
        } else {
          root.classList.remove('dark');
        }
      }
    };

    // Apply color theme via data-theme attribute
    // Validate colorTheme against known themes, fallback to 'default' if invalid/removed
    const colorTheme = sanitizeColorTheme(settings.colorTheme);

    if (colorTheme === 'default') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', colorTheme);
    }

    applyTheme();

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (settings.theme === 'system') {
        applyTheme();
      }
    };
    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [settings.theme, settings.colorTheme]);

  // Apply the interface font (overrides the stylesheet's Anthropic Sans stack)
  useEffect(() => {
    const stack = INTERFACE_FONT_STACKS[settings.interfaceFont ?? 'anthropic-sans'];
    if (stack) {
      document.documentElement.style.setProperty('--font-sans', stack);
    } else {
      document.documentElement.style.removeProperty('--font-sans');
    }
  }, [settings.interfaceFont]);

  // Update selected task when tasks change (for real-time updates)
  useEffect(() => {
    if (!selectedTask) {
      debugLog('[App] No selected task to update');
      return;
    }

    const updatedTask = tasks.find(
      (t) => t.id === selectedTask.id || t.specId === selectedTask.specId
    );

    debugLog('[App] Task lookup result', {
      found: !!updatedTask,
      updatedTaskId: updatedTask?.id,
      selectedTaskId: selectedTask.id,
    });

    if (!updatedTask) {
      debugLog('[App] Updated task not found in tasks array');
      return;
    }

    // Compare all mutable fields that affect UI state
    const subtasksChanged =
      JSON.stringify(selectedTask.subtasks || []) !==
      JSON.stringify(updatedTask.subtasks || []);
    const statusChanged = selectedTask.status !== updatedTask.status;
    const titleChanged = selectedTask.title !== updatedTask.title;
    const descriptionChanged = selectedTask.description !== updatedTask.description;
    const metadataChanged =
      JSON.stringify(selectedTask.metadata || {}) !==
      JSON.stringify(updatedTask.metadata || {});
    const executionProgressChanged =
      JSON.stringify(selectedTask.executionProgress || {}) !==
      JSON.stringify(updatedTask.executionProgress || {});
    const qaReportChanged =
      JSON.stringify(selectedTask.qaReport || {}) !==
      JSON.stringify(updatedTask.qaReport || {});
    const reviewReasonChanged = selectedTask.reviewReason !== updatedTask.reviewReason;
    const logsChanged =
      JSON.stringify(selectedTask.logs || []) !==
      JSON.stringify(updatedTask.logs || []);
    // The Claude Code run (session, steps, costs) is replaced as a whole on every update
    const claudeRunChanged = selectedTask.claudeRun !== updatedTask.claudeRun;

    const hasChanged =
      subtasksChanged || statusChanged || titleChanged || descriptionChanged ||
      metadataChanged || executionProgressChanged || qaReportChanged ||
      reviewReasonChanged || logsChanged || claudeRunChanged;

    debugLog('[App] Task comparison', {
      hasChanged,
      changes: {
        subtasks: subtasksChanged,
        status: statusChanged,
        title: titleChanged,
        description: descriptionChanged,
        metadata: metadataChanged,
        executionProgress: executionProgressChanged,
        qaReport: qaReportChanged,
        reviewReason: reviewReasonChanged,
        logs: logsChanged,
        claudeRun: claudeRunChanged,
      },
    });

    if (hasChanged) {
      const reasons = [];
      if (subtasksChanged) reasons.push('Subtasks');
      if (statusChanged) reasons.push('Status');
      if (titleChanged) reasons.push('Title');
      if (descriptionChanged) reasons.push('Description');
      if (metadataChanged) reasons.push('Metadata');
      if (executionProgressChanged) reasons.push('ExecutionProgress');
      if (qaReportChanged) reasons.push('QAReport');
      if (reviewReasonChanged) reasons.push('ReviewReason');
      if (logsChanged) reasons.push('Logs');
      if (claudeRunChanged) reasons.push('ClaudeRun');

      debugLog('[App] Updating selectedTask', {
        taskId: updatedTask.id,
        reason: reasons.join(', '),
      });
      setSelectedTask(updatedTask);
    }
  }, [tasks, selectedTask?.id, selectedTask?.specId, selectedTask]);

  const handleTaskClick = (task: Task) => {
    setSelectedTask(task);
  };

  const handleRefreshTasks = async () => {
    const currentProjectId = activeProjectId || selectedProjectId;
    if (!currentProjectId) return;
    setIsRefreshingTasks(true);
    try {
      // Pass forceRefresh: true to invalidate cache and get fresh data from disk
      // This ensures the refresh button always shows the latest task state
      await loadTasks(currentProjectId, { forceRefresh: true });
    } finally {
      setIsRefreshingTasks(false);
    }
  };

  const handleCloseTaskDetail = () => {
    setSelectedTask(null);
  };

  const [addProjectInitialStep, setAddProjectInitialStep] = useState<AddProjectModalStep>('choose');

  const handleAddProject = () => {
    setAddProjectInitialStep('choose');
    setShowAddProjectModal(true);
  };

  // Welcome page actions go straight to their flow instead of the "Add Project" choice
  const handleNewProject = () => {
    setAddProjectInitialStep('create-form');
    setShowAddProjectModal(true);
  };

  const handleOpenExistingProject = async () => {
    try {
      const project = await pickAndAddExistingProject();
      if (project) {
        handleProjectAdded(project, !project.autoBuildPath);
      }
    } catch (err) {
      console.error('Failed to open project:', err);
    }
  };

  // Offer to create the project's .workbench folder (the project has none yet)
  const askToInitialize = useCallback((project: Project) => {
    setPendingProject(project);
    setInitError(null);
    setInitSuccess(false);
    setShowInitDialog(true);
  }, []);

  /**
   * A project the user just added or created opens like any project card: a window showing no
   * project takes it, otherwise the dialog asks for this window or a new one. The initialize
   * prompt waits for that answer, and a project opened in a new window is set up from there
   * (its project menu and Settings > Project both offer it) rather than from this window.
   */
  const handleProjectAdded = (project: Project, needsInit: boolean) => {
    if (!activeProjectId && !selectedProjectId) {
      openProjectTab(project.id);
      // Adding the project no longer selects it, so this window says so itself
      setActiveProject(project.id);
      if (needsInit) askToInitialize(project);
      return;
    }
    setProjectToOpen(project);
    setProjectToInitialize(needsInit ? project : null);
  };

  // Show a project in this window; leaving the Projects page for its board
  const handleSelectProject = useCallback((projectId: string) => {
    openProjectTab(projectId);
    setActiveProject(projectId);
    setActiveView((view) => (view === 'projects' ? 'kanban' : view));
  }, [openProjectTab, setActiveProject]);

  /**
   * A project card on the Projects page: the project this window already shows just opens its
   * board, a project open in another window focuses that window, and anything else asks
   * whether to use this window or a new one.
   */
  const handleOpenProject = useCallback((projectId: string) => {
    if (projectId === (activeProjectId || selectedProjectId)) {
      setActiveView((view) => (view === 'projects' ? 'kanban' : view));
      return;
    }

    // Open brings the project's window to the front when it already has one
    if (windowedProjectIds.has(projectId)) {
      void openProjectWindow(projectId);
      return;
    }

    const project = projects.find((p) => p.id === projectId);
    if (project) setProjectToOpen(project);
  }, [activeProjectId, selectedProjectId, projects, windowedProjectIds]);

  // "This window" in the open dialog
  const handleOpenProjectHere = useCallback(() => {
    if (!projectToOpen) return;
    handleSelectProject(projectToOpen.id);
    const initialize = projectToInitialize?.id === projectToOpen.id ? projectToInitialize : null;
    setProjectToOpen(null);
    setProjectToInitialize(null);
    if (initialize) askToInitialize(initialize);
  }, [projectToOpen, projectToInitialize, handleSelectProject, askToInitialize]);

  // "New window" in the open dialog
  const handleOpenProjectInNewWindow = useCallback(() => {
    if (!projectToOpen) return;
    void openProjectWindow(projectToOpen.id);
    setProjectToOpen(null);
    setProjectToInitialize(null);
  }, [projectToOpen]);

  // "Quit window" on an open project's card: close that project's window
  const handleQuitProjectWindow = useCallback((projectId: string) => {
    void closeProjectWindow(projectId);
  }, []);

  // "Open agent" in task details opens the task's session in a new agent window: close the task
  // dialog and show the Agents page of the task's project
  const agentsViewRequest = useTerminalStore((state) => state.agentsViewRequest);
  const handledAgentsViewSeqRef = useRef(0);
  useEffect(() => {
    if (!agentsViewRequest || agentsViewRequest.seq === handledAgentsViewSeqRef.current) return;
    handledAgentsViewSeqRef.current = agentsViewRequest.seq;
    setSelectedTask(null);
    const project = projects.find((p) => p.path === agentsViewRequest.projectPath);
    if (project && project.id !== (activeProjectId || selectedProjectId)) {
      handleSelectProject(project.id);
    }
    setActiveView('terminals');
  }, [agentsViewRequest, projects, activeProjectId, selectedProjectId, handleSelectProject]);

  const handleProjectTabClose = (projectId: string) => {
    // Show confirmation dialog before removing the project
    const project = projects.find(p => p.id === projectId);
    if (project) {
      setProjectToRemove(project);
      setShowRemoveProjectDialog(true);
    }
  };

  const handleConfirmRemoveProject = () => {
    if (projectToRemove) {
      try {
        // Clear any previous error
        setRemoveProjectError(null);
        // Remove the project from the app (files are preserved on disk for re-adding later)
        removeProject(projectToRemove.id);
        // Only clear dialog state on success
        setShowRemoveProjectDialog(false);
        setProjectToRemove(null);
      } catch (err) {
        // Log error and keep dialog open so user can retry or cancel
        console.error('[App] Failed to remove project:', err);
        // Show error in dialog
        setRemoveProjectError(
          err instanceof Error ? err.message : t('common:errors.unknownError')
        );
      }
    }
  };

  const handleCancelRemoveProject = () => {
    setShowRemoveProjectDialog(false);
    setProjectToRemove(null);
    setRemoveProjectError(null);
  };

  const handleInitialize = async () => {
    if (!pendingProject) return;

    const projectId = pendingProject.id;
    console.warn('[InitDialog] Starting initialization for project:', projectId);
    setIsInitializing(true);
    setInitSuccess(false);
    setInitError(null); // Clear any previous errors
    try {
      const result = await initializeProject(projectId);
      console.warn('[InitDialog] Initialization result:', result);

      if (result?.success) {
        console.warn('[InitDialog] Initialization successful, closing dialog');

        // Mark as successful to prevent onOpenChange from treating this as a skip
        setInitSuccess(true);
        setIsInitializing(false);

        // Now close the dialog
        setShowInitDialog(false);
        setPendingProject(null);
      } else {
        // Initialization failed - show error but keep dialog open
        console.warn('[InitDialog] Initialization failed, showing error');
        const errorMessage = result?.error || 'Failed to initialize Workbench. Please try again.';
        setInitError(errorMessage);
        setIsInitializing(false);
      }
    } catch (error) {
      // Unexpected error occurred
      console.error('[InitDialog] Unexpected error during initialization:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
      setInitError(errorMessage);
      setIsInitializing(false);
    }
  };

  const handleSkipInit = () => {
    console.warn('[InitDialog] User skipped initialization');
    if (pendingProject) {
      setSkippedInitProjectId(pendingProject.id);
    }
    setShowInitDialog(false);
    setPendingProject(null);
    setInitError(null); // Clear any error when skipping
    setInitSuccess(false); // Reset success flag
  };

  return (
    <ViewStateProvider>
      <TooltipProvider>
        <ProactiveSwapListener />
      <div className="flex h-screen bg-background">
        {/* Sidebar */}
        <Sidebar
          onSettingsClick={() => setIsSettingsDialogOpen(true)}
          onNewTaskClick={() => setIsNewTaskDialogOpen(true)}
          activeView={activeView}
          onViewChange={setActiveView}
        />

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Window drag strip; on Windows/Linux it also reserves the row the window controls sit in.
              Insights draws its own so its chat history column can run the full height, except in
              development builds, where the DEVELOPMENT BUILD strip below has to stay under it */}
          {(IS_DEV_BUILD || !(activeView === 'insights' && selectedProject)) && (
            <div className="electron-drag shrink-0" style={{ height: TITLE_BAR_STRIP_HEIGHT }} />
          )}

          {/* Scrolling DEVELOPMENT BUILD strip (npm run dev only) */}
          <DevBuildBar />

          {/* Main content area */}
          <main className="flex-1 overflow-hidden">
            {activeView === 'projects' ? (
              <ProjectsPage
                projects={projects}
                activeProjectId={activeProjectId || selectedProjectId}
                windowedProjectIds={windowedProjectIds}
                canQuitWindow={windowCount > 1}
                onSelectProject={handleOpenProject}
                onAddProject={handleAddProject}
                onRemoveProject={handleProjectTabClose}
                onQuitProjectWindow={handleQuitProjectWindow}
              />
            ) : selectedProject ? (
              <>
                {activeView === 'kanban' && (
                  <KanbanBoard
                    tasks={tasks}
                    onTaskClick={handleTaskClick}
                    onNewTaskClick={() => setIsNewTaskDialogOpen(true)}
                    onRefresh={handleRefreshTasks}
                    isRefreshing={isRefreshingTasks}
                  />
                )}
                {/* TerminalGrid is always mounted but hidden when not active to preserve terminal state */}
                <div className={activeView === 'terminals' ? 'h-full' : 'hidden'}>
                  <TerminalGrid
                    projectPath={selectedProject?.path}
                    onNewTaskClick={() => setIsNewTaskDialogOpen(true)}
                  />
                </div>
                {activeView === 'insights' && (activeProjectId || selectedProjectId) && (
                  <Insights projectId={activeProjectId || selectedProjectId!} />
                )}
                {activeView === 'memory' && (activeProjectId || selectedProjectId) && (
                  <MemoryGraph projectId={activeProjectId || selectedProjectId!} />
                )}
              </>
            ) : (
              <WelcomeScreen
                onNewProject={handleNewProject}
                onOpenProject={handleOpenExistingProject}
              />
            )}
          </main>
        </div>

        {/* Task detail modal */}
        <TaskDetailModal
          open={!!selectedTask}
          task={selectedTask}
          onOpenChange={(open) => !open && handleCloseTaskDetail()}
        />

        {/* Dialogs */}
        {(activeProjectId || selectedProjectId) && (
          <TaskCreationWizard
            projectId={activeProjectId || selectedProjectId!}
            open={isNewTaskDialogOpen}
            onOpenChange={setIsNewTaskDialogOpen}
          />
        )}

        <AppSettingsDialog
          open={isSettingsDialogOpen}
          onOpenChange={(open) => {
            setIsSettingsDialogOpen(open);
            if (!open) {
              // Reset initial sections when dialog closes
              setSettingsInitialSection(undefined);
              setSettingsInitialProjectSection(undefined);
              setSettingsFocusId(undefined);
            }
          }}
          initialSection={settingsInitialSection}
          focusId={settingsFocusId}
          initialProjectSection={settingsInitialProjectSection}
        />

        {/* Add Project Modal */}
        <AddProjectModal
          open={showAddProjectModal}
          onOpenChange={setShowAddProjectModal}
          onProjectAdded={handleProjectAdded}
          initialStep={addProjectInitialStep}
        />

        {/* Initialize Workbench Dialog */}
        <Dialog open={showInitDialog} onOpenChange={(open) => {
          console.warn('[InitDialog] onOpenChange called', { open, pendingProject: !!pendingProject, isInitializing, initSuccess });
          // Only trigger skip if user manually closed the dialog
          // Don't trigger if: successful init, no pending project, or currently initializing
          if (!open && pendingProject && !isInitializing && !initSuccess) {
            handleSkipInit();
          }
        }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t('initialize.title')}
              </DialogTitle>
              <DialogDescription>
                {t('initialize.description')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
                <p className="text-foreground mb-2">{t('initialize.willDo')}</p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t('initialize.createFolder')}</li>
                  <li>{t('initialize.setupSpecs')}</li>
                </ul>
              </div>
              {initError && (
                <div className="text-sm" role="alert">
                  <p className="text-destructive">{t('initialize.initFailed')}</p>
                  <p className="text-muted-foreground mt-1">
                    {initError}
                  </p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleSkipInit} disabled={isInitializing}>
                {t('common:buttons.skip', { ns: 'common' })}
              </Button>
              <Button
                size="sm"
                onClick={handleInitialize}
                disabled={isInitializing}
              >
                {isInitializing ? (
                  <>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('common:labels.initializing', { ns: 'common' })}
                  </>
                ) : (
                  t('common:buttons.initialize', { ns: 'common' })
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Open a project: this window or a new one */}
        <Dialog
          open={!!projectToOpen}
          onOpenChange={(open) => {
            if (open) return;
            setProjectToOpen(null);
            setProjectToInitialize(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('openProject.title', { projectName: projectToOpen?.name || '' })}</DialogTitle>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleOpenProjectHere}>
                {t('openProject.thisWindow')}
              </Button>
              <Button size="sm" onClick={handleOpenProjectInNewWindow}>
                {t('openProject.newWindow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Remove Project Confirmation Dialog */}
        <Dialog open={showRemoveProjectDialog} onOpenChange={(open) => {
          if (!open) handleCancelRemoveProject();
        }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('removeProject.title')}</DialogTitle>
              <DialogDescription>
                {t('removeProject.description', { projectName: projectToRemove?.name || '' })}
              </DialogDescription>
            </DialogHeader>
            {removeProjectError && (
              <p className="mt-4 text-sm text-destructive" role="alert">
                {removeProjectError}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={handleCancelRemoveProject}>
                {t('removeProject.cancel')}
              </Button>
              <Button variant="destructive" size="sm" onClick={handleConfirmRemoveProject}>
                {t('removeProject.remove')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Auth Failure Modal - shows when Claude CLI encounters 401/auth errors */}
        <AuthFailureModal onOpenSettings={() => {
          setSettingsInitialSection('accounts');
          setIsSettingsDialogOpen(true);
        }} />

        {/* App Update Notification - shows when new app version is available */}
        <AppUpdateNotification />
      </div>
      </TooltipProvider>
    </ViewStateProvider>
  );
}
