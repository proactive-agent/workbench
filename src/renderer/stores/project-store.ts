import { create } from 'zustand';
import type { Project, ProjectSettings, AutoBuildVersionInfo, InitializationResult } from '../../shared/types';
import { debugLog } from '../../shared/utils/debug-logger';

// localStorage keys for persisting project state (legacy - now using IPC)
const LAST_SELECTED_PROJECT_KEY = 'lastSelectedProjectId';

/** Where a window opened for a project remembers the project it shows (per window, kept across reloads) */
const WINDOW_PROJECT_KEY = 'windowProjectId';

/**
 * Stored instead of a project id when the window has deliberately moved off its project and onto
 * no project at all.
 *
 * Nothing stored means the window has not chosen yet and still shows the project it was opened
 * for, so "no project" needs a value of its own: without one, a window whose only project was
 * removed would fall straight back to that removed project. Project ids are UUIDs, so this can
 * never be mistaken for one.
 */
const NO_WINDOW_PROJECT = '__none__';

/**
 * Project this window was opened for ("New window" on the Projects page).
 *
 * Such a window keeps its own project instead of the restored one, and leaves the stored
 * tab state (and the last-selected key, which every window shares) to the first window.
 */
function assignedProjectId(): string | null {
  return typeof window === 'undefined' ? null : window.electronAPI?.assignedProjectId ?? null;
}

/** Session storage is per window and survives a reload; it may be blocked, so never required */
function readWindowProject(): string | null {
  try {
    return sessionStorage.getItem(WINDOW_PROJECT_KEY);
  } catch {
    return null;
  }
}

/** Records the window's choice; a null project is a choice too, and is kept as such */
function writeWindowProject(projectId: string | null): void {
  try {
    sessionStorage.setItem(WINDOW_PROJECT_KEY, projectId ?? NO_WINDOW_PROJECT);
  } catch {
    // Storage blocked: the window still works, it just forgets on reload
  }
}

/** The project a window opened for a project should show: what it last switched to, else the one it was opened for */
function windowProjectId(): string | null {
  const assigned = assignedProjectId();
  if (!assigned) return null;
  const stored = readWindowProject();
  // The window chose no project, which outranks the one it was opened for
  if (stored === NO_WINDOW_PROJECT) return null;
  return stored ?? assigned;
}

// Debounce timer for saving tab state
let saveTabStateTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether this window has set its own tabs since it loaded.
 *
 * The stored tab state is an echo of what a window last saved, so it is only worth restoring
 * while the window has no tabs of its own. Afterwards the in-memory state is the newer of the
 * two, and restoring the stored one again would undo the change that triggered the reload: a
 * project added anywhere makes every window reload its projects, and the window that opened a
 * tab for that project would lose it again, leaving the board and Settings on different
 * projects.
 */
let tabsSetInThisWindow = false;

interface ProjectState {
  projects: Project[];
  selectedProjectId: string | null;
  isLoading: boolean;
  error: string | null;

  // Tab state
  openProjectIds: string[]; // Array of open project IDs
  activeProjectId: string | null; // Currently active tab
  tabOrder: string[]; // Order of tabs for drag and drop

  // Actions
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  updateProject: (projectId: string, updates: Partial<Project>) => void;
  selectProject: (projectId: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Tab management actions
  openProjectTab: (projectId: string) => void;
  closeProjectTab: (projectId: string) => void;
  setActiveProject: (projectId: string | null) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  restoreTabState: () => void;

  // Selectors
  getSelectedProject: () => Project | undefined;
  getOpenProjects: () => Project[];
  getActiveProject: () => Project | undefined;
  getProjectTabs: () => Project[];
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectId: null,
  isLoading: false,
  error: null,

  // Tab state - initialized empty, loaded via IPC from main process for reliability
  openProjectIds: [],
  activeProjectId: null,
  tabOrder: [],

  setProjects: (projects) => set({ projects }),

  addProject: (project) =>
    set((state) => ({
      projects: [...state.projects, project]
    })),

  removeProject: (projectId) => {
    const state = get();
    const projects = state.projects.filter((p) => p.id !== projectId);
    // The tab for a project that is gone goes with it in every window, rather than sitting in
    // the bar until the next project-list reload happens to clean it up
    const openProjectIds = state.openProjectIds.filter((id) => id !== projectId);
    const tabOrder = state.tabOrder.filter((id) => id !== projectId);

    // A window showing the project that was just removed would keep showing it: it falls back
    // to the project it was opened with whenever it has stored none, so forgetting is not
    // enough and it is pointed at another project instead - at none when that was the last
    // project there was, which is recorded rather than forgotten so the fallback cannot bring
    // the removed project back.
    //
    // The comparison is against windowProjectId() rather than the project this window was
    // opened for, because the two part company as soon as the user switches the window to
    // another project: a window opened for the removed project but switched away from it has
    // nothing to re-point, while a window switched onto the removed project has. It is also
    // the fallback this guards against, since windowProjectId() is what a project-list reload
    // puts the window back on, and it answers null for a window that was not opened for a
    // project at all, which has no choice of its own to repair - the shared last-selected key
    // below is where such a window remembers its project.
    if (windowProjectId() === projectId) {
      const replacement = projects.find((p) => openProjectIds.includes(p.id))?.id ?? projects[0]?.id ?? null;
      set({ projects, openProjectIds, tabOrder, selectedProjectId: replacement, activeProjectId: replacement });
      if (replacement) {
        // The replacement is not always a project this window has a tab for, since the removed
        // project may have been its only tab, and a board showing a project the tab bar has no
        // tab for is the two disagreeing until the next project load heals it. So it is opened
        // the way every other path opens a project, which gives it a tab and persists the tab
        // state - for a window opened for a project, its own remembered choice.
        get().openProjectTab(replacement);
      } else {
        // Nothing is left to show, and that choice is recorded rather than forgotten so the
        // fallback cannot bring the removed project back
        writeWindowProject(null);
      }
      return;
    }

    const isSelectedProject = state.selectedProjectId === projectId;
    // Forget the removed project if it was the selected one. Only the shared key is cleared:
    // a window opened for a project keeps its own choice in session storage, and that choice
    // is not the removed project here, so dropping it would send the window back to the
    // project it was opened for over a removal that never touched what it shows.
    if (isSelectedProject && !assignedProjectId()) {
      localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
    }

    // A window that was not opened for a project - the ordinary one - never reaches the branch
    // above, so removing the project it is showing has to be repaired here too: the board would
    // otherwise go on pointing at a project that is gone, with no tab and nothing to heal it until
    // the next project load.
    const wasActive = state.activeProjectId === projectId;
    const replacement = wasActive
      ? projects.find((p) => openProjectIds.includes(p.id))?.id ?? projects[0]?.id ?? null
      : state.activeProjectId;
    set({
      projects,
      openProjectIds,
      tabOrder,
      // The selection is the board's and Settings' own, and clearing it is what the removal of the
      // selected project has always meant; only the active tab needed repairing here
      selectedProjectId: isSelectedProject ? null : state.selectedProjectId,
      activeProjectId: replacement
    });
    // Opened the way every other path opens a project, so it gets a tab and the tab state is
    // persisted rather than left for a reload to discover
    if (wasActive && replacement) get().openProjectTab(replacement);
  },

  updateProject: (projectId, updates) =>
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, ...updates } : p
      )
    })),

  selectProject: (projectId) => {
    // Persist for restoration on app reload: a window opened for a project keeps its own
    // (session storage), the first window owns the shared last-selected key
    if (assignedProjectId()) {
      writeWindowProject(projectId);
    } else if (projectId) {
      localStorage.setItem(LAST_SELECTED_PROJECT_KEY, projectId);
    } else {
      localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
    }
    set({ selectedProjectId: projectId });
  },

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  // Tab management actions
  openProjectTab: (projectId) => {
    const state = get();
    debugLog('[ProjectStore] openProjectTab called:', {
      projectId,
      currentOpenProjectIds: state.openProjectIds,
      currentTabOrder: state.tabOrder
    });
    if (!state.openProjectIds.includes(projectId)) {
      const newOpenProjectIds = [...state.openProjectIds, projectId];
      const newTabOrder = state.tabOrder.includes(projectId)
        ? state.tabOrder
        : [...state.tabOrder, projectId];

      debugLog('[ProjectStore] Adding new tab:', {
        newOpenProjectIds,
        newTabOrder
      });

      set({
        openProjectIds: newOpenProjectIds,
        tabOrder: newTabOrder,
        activeProjectId: projectId
      });

      // Save to main process (debounced)
      saveTabStateToMain();
    } else {
      debugLog('[ProjectStore] Project already open, just activating');
      // Project already open, just make it active
      get().setActiveProject(projectId);
    }
  },

  closeProjectTab: (projectId) => {
    const state = get();
    const newOpenProjectIds = state.openProjectIds.filter(id => id !== projectId);
    const newTabOrder = state.tabOrder.filter(id => id !== projectId);

    // If closing the active project, select another one or null
    let newActiveProjectId = state.activeProjectId;
    if (state.activeProjectId === projectId) {
      const remainingTabs = newTabOrder.length > 0 ? newTabOrder : [];
      newActiveProjectId = remainingTabs.length > 0 ? remainingTabs[0] : null;
    }

    set({
      openProjectIds: newOpenProjectIds,
      tabOrder: newTabOrder,
      activeProjectId: newActiveProjectId
    });

    // Save to main process (debounced)
    saveTabStateToMain();
  },

  setActiveProject: (projectId) => {
    // The project shown is the latest opened (the main process records it with the tab state)
    if (projectId && projectId !== get().activeProjectId) {
      set((state) => ({
        projects: state.projects.map((p) => (p.id === projectId ? { ...p, lastOpenedAt: new Date() } : p))
      }));
    }
    set({ activeProjectId: projectId });
    // Also update selectedProjectId for backward compatibility
    get().selectProject(projectId);
    // Save to main process (debounced)
    saveTabStateToMain();
  },

  reorderTabs: (fromIndex, toIndex) => {
    const state = get();
    const newTabOrder = [...state.tabOrder];
    const [movedTab] = newTabOrder.splice(fromIndex, 1);
    newTabOrder.splice(toIndex, 0, movedTab);

    set({ tabOrder: newTabOrder });
    // Save to main process (debounced)
    saveTabStateToMain();
  },

  restoreTabState: () => {
    // This is now handled by loadTabStateFromMain() called during loadProjects()
    debugLog('[ProjectStore] restoreTabState called - now handled by IPC');
  },


  // Original selectors
  getSelectedProject: () => {
    const state = get();
    return state.projects.find((p) => p.id === state.selectedProjectId);
  },

  // New selectors for tab functionality
  getOpenProjects: () => {
    const state = get();
    return state.projects.filter((p) => state.openProjectIds.includes(p.id));
  },

  getActiveProject: () => {
    const state = get();
    return state.projects.find((p) => p.id === state.activeProjectId);
  },

  getProjectTabs: () => {
    const state = get();
    const orderedProjects = state.tabOrder
      .map(id => state.projects.find(p => p.id === id))
      .filter(Boolean) as Project[];

    // Add any open projects not in tabOrder to the end
    const remainingProjects = state.projects
      .filter(p => state.openProjectIds.includes(p.id) && !state.tabOrder.includes(p.id));

    return [...orderedProjects, ...remainingProjects];
  }
}));

/**
 * Save tab state to main process (debounced to avoid excessive IPC calls)
 */
function saveTabStateToMain(): void {
  // Every tab change passes through here, so this is where a later project-list reload learns
  // that the state it would restore is already out of date
  tabsSetInThisWindow = true;

  // A window opened for a project keeps its project to itself (so a reload brings back what
  // it was showing, not what it was opened with) and leaves the shared tab state alone
  if (assignedProjectId()) {
    writeWindowProject(useProjectStore.getState().activeProjectId);
    return;
  }

  // Clear any pending save
  if (saveTabStateTimeout) {
    clearTimeout(saveTabStateTimeout);
  }

  // Debounce saves to avoid excessive IPC calls
  saveTabStateTimeout = setTimeout(async () => {
    const store = useProjectStore.getState();
    const tabState = {
      openProjectIds: store.openProjectIds,
      activeProjectId: store.activeProjectId,
      tabOrder: store.tabOrder
    };
    debugLog('[ProjectStore] Saving tab state to main process:', tabState);
    try {
      await window.electronAPI.saveTabState(tabState);
    } catch (err) {
      console.error('[ProjectStore] Failed to save tab state:', err);
    }
  }, 100);
}

/**
 * Load projects from main process
 */
export async function loadProjects(): Promise<void> {
  const store = useProjectStore.getState();
  store.setLoading(true);
  store.setError(null);

  try {
    // First, load tab state from main process (reliable persistence)
    const tabStateResult = await window.electronAPI.getTabState();
    debugLog('[ProjectStore] Loaded tab state from main process:', tabStateResult.data);

    // Only while this window has no tabs of its own: once it has, they are the newer of the two
    // (a project just added and opened is what made this reload run), so they stand
    if (tabStateResult.success && tabStateResult.data && !tabsSetInThisWindow) {
      useProjectStore.setState({
        openProjectIds: tabStateResult.data.openProjectIds || [],
        activeProjectId: tabStateResult.data.activeProjectId || null,
        tabOrder: tabStateResult.data.tabOrder || []
      });
    }

    // A window opened for one project shows it from the first render (no flash of another)
    const assigned = windowProjectId();
    if (assigned) {
      store.openProjectTab(assigned);
      store.setActiveProject(assigned);
    }

    // Then load projects
    const result = await window.electronAPI.getProjects();
    debugLog('[ProjectStore] getProjects result:', {
      success: result.success,
      projectCount: result.data?.length,
      projectIds: result.data?.map(p => p.id)
    });

    if (result.success && result.data) {
      store.setProjects(result.data);

      // Get current tab state (may have been loaded from IPC)
      const currentState = useProjectStore.getState();

      // Clean up tab state - remove any project IDs that no longer exist
      const validOpenProjectIds = currentState.openProjectIds.filter(id =>
        result.data?.some((p) => p.id === id) ?? false
      );
      const validTabOrder = currentState.tabOrder.filter(id =>
        result.data?.some((p) => p.id === id) ?? false
      );
      const validActiveProjectId = currentState.activeProjectId &&
        result.data?.some((p) => p.id === currentState.activeProjectId)
        ? currentState.activeProjectId
        : null;

      debugLog('[ProjectStore] Tab state cleanup:', {
        originalOpenProjectIds: currentState.openProjectIds,
        validOpenProjectIds,
        originalTabOrder: currentState.tabOrder,
        validTabOrder,
        originalActiveProjectId: currentState.activeProjectId,
        validActiveProjectId
      });

      // Update store with cleaned tab state if needed
      if (validOpenProjectIds.length !== currentState.openProjectIds.length ||
          validTabOrder.length !== currentState.tabOrder.length ||
          validActiveProjectId !== currentState.activeProjectId) {
        debugLog('[ProjectStore] Updating cleaned tab state');
        useProjectStore.setState({
          openProjectIds: validOpenProjectIds,
          tabOrder: validTabOrder,
          activeProjectId: validActiveProjectId
        });
        // Save cleaned state back to main process
        saveTabStateToMain();
      } else {
        debugLog('[ProjectStore] Tab state is valid, no cleanup needed');
      }

      // Restore last selected project from localStorage for backward compatibility,
      // or fall back to active project, or first project
      const updatedState = useProjectStore.getState();
      if (!updatedState.selectedProjectId && result.data.length > 0) {
        const lastSelectedId = localStorage.getItem(LAST_SELECTED_PROJECT_KEY);
        const projectExists = lastSelectedId && result.data.some((p) => p.id === lastSelectedId);

        if (projectExists) {
          store.selectProject(lastSelectedId);
        } else if (updatedState.activeProjectId) {
          store.selectProject(updatedState.activeProjectId);
        } else {
          store.selectProject(result.data[0].id);
        }
      }
    } else {
      store.setError(result.error || 'Failed to load projects');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    store.setLoading(false);
  }
}

/**
 * Add a new project.
 *
 * The project is only added to the list: which window ends up showing it is the caller's
 * decision, because a window that already shows a project first asks whether to use it or open
 * a new one. Switching here would answer that question before it is asked, and "New window"
 * would then leave the project this window was showing without a window at all.
 */
export async function addProject(projectPath: string): Promise<Project | null> {
  const store = useProjectStore.getState();

  try {
    const result = await window.electronAPI.addProject(projectPath);
    if (result.success && result.data) {
      store.addProject(result.data);
      return result.data;
    } else {
      store.setError(result.error || 'Failed to add project');
      return null;
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

/**
 * Remove a project
 */
export async function removeProject(projectId: string): Promise<boolean> {
  const store = useProjectStore.getState();

  try {
    const result = await window.electronAPI.removeProject(projectId);
    if (result.success) {
      store.removeProject(projectId);
      // Also close the tab if it's open
      if (store.openProjectIds.includes(projectId)) {
        store.closeProjectTab(projectId);
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Update project settings
 */
export async function updateProjectSettings(
  projectId: string,
  settings: Partial<ProjectSettings>
): Promise<boolean> {
  const store = useProjectStore.getState();

  try {
    const result = await window.electronAPI.updateProjectSettings(
      projectId,
      settings
    );
    if (result.success) {
      const project = store.projects.find((p) => p.id === projectId);
      if (project) {
        // Merge settings properly, handling the case where project.settings might be undefined
        const currentSettings = project.settings || {};
        store.updateProject(projectId, {
          settings: { ...currentSettings, ...settings }
        });
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check workbench version status for a project
 */
export async function checkProjectVersion(
  projectId: string
): Promise<AutoBuildVersionInfo | null> {
  try {
    const result = await window.electronAPI.checkProjectVersion(projectId);
    if (result.success && result.data) {
      return result.data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Initialize workbench in a project
 */
export async function initializeProject(
  projectId: string
): Promise<InitializationResult | null> {
  const store = useProjectStore.getState();

  try {
    debugLog('[ProjectStore] initializeProject called for:', projectId);
    const result = await window.electronAPI.initializeProject(projectId);
    debugLog('[ProjectStore] IPC result:', result);

    if (result.success && result.data) {
      debugLog('[ProjectStore] IPC succeeded, result.data:', result.data);
      // Update the project's autoBuildPath in local state
      if (result.data.success) {
        debugLog('[ProjectStore] Updating project autoBuildPath to .workbench');
        store.updateProject(projectId, { autoBuildPath: '.workbench' });
      } else {
        debugLog('[ProjectStore] result.data.success is false, not updating project');
      }
      return result.data;
    }
    debugLog('[ProjectStore] IPC failed or no data, setting error');
    store.setError(result.error || 'Failed to initialize project');
    return null;
  } catch (error) {
    console.error('[ProjectStore] Exception during initializeProject:', error);
    store.setError(error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}
