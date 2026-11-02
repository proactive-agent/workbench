import { ipcMain } from 'electron';
import { existsSync } from 'fs';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  Project,
  ProjectSettings,
  IPCResult,
  InitializationResult,
  AutoBuildVersionInfo,
  GitStatus,
  GitBranchDetail,
  ProjectCostMetrics
} from '../../shared/types';
import { appLog } from '../app-logger';
import { setLiveAgentEnabled } from '../live-agent/live-agent-projects';
import { projectStore } from '../project-store';
import { applyProjectMemory, removeProjectMemory } from '../self-improve';
import { getProjectCostMetrics, warmProjectMetrics } from '../project-metrics';
import { stopWatchingProjectMetrics, watchProjectMetrics } from '../project-metrics-watcher';
import { migrateProjectDataDirs } from '../data-dir-migration';
import {
  initializeProject,
  isInitialized,
  hasLocalSource,
  checkGitStatus,
  initializeGit
} from '../project-initializer';
import { git } from '../utils/git-exec';
import { safeSendToRenderer } from './utils';
import type { BrowserWindow } from 'electron';


// ============================================
// Git Helper Functions
// ============================================

/**
 * Get list of git branches for a directory (both local and remote), from the refs already known
 * locally (remote refs are only fetched by the branch pickers' refresh button)
 */
async function getGitBranches(projectPath: string): Promise<string[]> {
  try {
    // Get all branches (local + remote) using --all flag
    const { stdout: result } = await git(['branch', '--all', '--format=%(refname:short)'], {
      cwd: projectPath,
      encoding: 'utf-8'
    });

    const branches = result.trim().split('\n')
      .filter(b => b.trim())
      .map(b => {
        // Remote branches come as "origin/branch-name", keep the full name
        // but remove the "origin/" prefix for display while keeping it usable
        return b.trim();
      })
      // Remove HEAD pointer entries like "origin/HEAD"
      .filter(b => !b.endsWith('/HEAD'))
      // Remove duplicates (local branch may exist alongside remote)
      .filter((branch, index, self) => {
        // If it's a remote branch (origin/x) and local version exists, keep local
        if (branch.startsWith('origin/')) {
          const localName = branch.replace('origin/', '');
          return !self.includes(localName);
        }
        return self.indexOf(branch) === index;
      });

    // Sort: local branches first, then remote branches
    return branches.sort((a, b) => {
      const aIsRemote = a.startsWith('origin/');
      const bIsRemote = b.startsWith('origin/');
      if (aIsRemote && !bIsRemote) return 1;
      if (!aIsRemote && bIsRemote) return -1;
      return a.localeCompare(b);
    });
  } catch {
    return [];
  }
}

/**
 * Get structured branch information for a directory (both local and remote)
 * Returns GitBranchDetail[] with type indicators, keeping both local and remote versions
 * when a branch exists in both places (no deduplication).
 *
 * Runs git asynchronously so the main process (and the UI) never waits on it. Remote refs are
 * only updated with `git fetch` when asked (a refresh button), never just to list branches.
 */
async function getGitBranchesWithInfo(projectPath: string, fetchRemote = false): Promise<GitBranchDetail[]> {
  const run = (args: string[], timeout?: number) =>
    git(args, { cwd: projectPath, encoding: 'utf-8', timeout }).then((r) => r.stdout);

  try {
    if (fetchRemote) {
      try {
        await run(['fetch', '--prune'], 10000);
      } catch {
        // Fetch may fail if offline or no remote, continue with local refs
      }
    }

    // Current branch (isCurrent indicator), local and remote branches, in parallel
    const [currentResult, localResult, remoteResult] = await Promise.all([
      run(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
      run(['branch', '--format=%(refname:short)']),
      // %(symref) marks pointers like origin/HEAD (short name "origin"), which aren't branches
      run(['for-each-ref', '--format=%(refname:short)%09%(symref)', 'refs/remotes']).catch(() => ''),
    ]);
    const currentBranch = currentResult.trim() || null;

    const localBranches: GitBranchDetail[] = localResult.trim().split('\n')
      .filter(b => b.trim())
      .map(b => {
        const name = b.trim();
        return { name, type: 'local' as const, displayName: name, isCurrent: name === currentBranch };
      });

    // Remote branches without the "origin/" prefix (clean names for PR targets etc.), minus HEAD
    // pointers and branches that also exist locally
    const localNames = new Set(localBranches.map(b => b.name));
    const remoteBranches: GitBranchDetail[] = remoteResult.trim().split('\n')
      .filter(line => line.trim() && !line.split('\t')[1])
      .map(line => line.split('\t')[0].trim())
      .filter(b => b && !b.endsWith('/HEAD'))
      .map(fullName => {
        const name = fullName.replace(/^origin\//, '');
        return { name, type: 'remote' as const, displayName: name, isCurrent: false };
      })
      .filter(b => !localNames.has(b.name));

    // Local branches first, then remote branches, alphabetically within each group
    return [...localBranches, ...remoteBranches].sort((a, b) => {
      if (a.type === 'local' && b.type === 'remote') return -1;
      if (a.type === 'remote' && b.type === 'local') return 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

/**
 * Get the current git branch for a directory
 */
async function getCurrentGitBranch(projectPath: string): Promise<string | null> {
  try {
    const { stdout: result } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8'
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Detect the main branch for a git repository
 * Checks for common main branch names in order of preference
 */
async function detectMainBranch(projectPath: string): Promise<string | null> {
  const branches = await getGitBranches(projectPath);
  if (branches.length === 0) return null;

  // Check for common main branch names in order of preference
  const mainBranchCandidates = ['main', 'master', 'develop', 'dev', 'trunk'];
  for (const candidate of mainBranchCandidates) {
    if (branches.includes(candidate)) {
      return candidate;
    }
  }

  // If none of the common names found, check for origin/HEAD reference
  try {
    const { stdout: result } = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8'
    });
    const ref = result.trim();
    // Extract branch name from refs/remotes/origin/main
    const match = ref.match(/refs\/remotes\/origin\/(.+)/);
    if (match && branches.includes(match[1])) {
      return match[1];
    }
  } catch {
    // origin/HEAD not set, continue with fallback
  }

  // Fallback: return the first branch (usually the current one)
  return branches[0] || null;
}

/**
 * Register all project-related IPC handlers
 */
export function registerProjectHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  // ============================================
  // Project Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_ADD,
    async (_, projectPath: string): Promise<IPCResult<Project>> => {
      try {
        // Validate path exists
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }

        const project = projectStore.addProject(projectPath);
        // A project used by an older version may still have the old data folder names
        await migrateProjectDataDirs(project.path, project.autoBuildPath);
        // Every window shows the same project list
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.PROJECT_LIST_CHANGED);
        return { success: true, data: project };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  /**
   * The first time a project is open in a window, read what its Claude Code sessions spent in the
   * background, so Metrics has the figures ready when it is opened.
   */
  const warmOpenProjects = (projectIds: string[]): void => {
    const open = projectStore.getProjects().filter((project) => projectIds.includes(project.id));
    warmProjectMetrics(open, () => {
      safeSendToRenderer(getMainWindow, IPC_CHANNELS.PROJECT_METRICS_CHANGED);
    });
  };

  // Spending per initialized project (Settings > Accounts > Metrics)
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_COST_METRICS,
    async (): Promise<IPCResult<ProjectCostMetrics[]>> => {
      try {
        return { success: true, data: await getProjectCostMetrics(projectStore.getProjects()) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }
  );

  // While the Metrics page is open, tell it when an agent window's session spends something
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_METRICS_WATCH,
    async (): Promise<IPCResult> => {
      await watchProjectMetrics(projectStore.getProjects(), () => {
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.PROJECT_METRICS_CHANGED);
      });
      return { success: true };
    }
  );

  ipcMain.handle(IPC_CHANNELS.PROJECT_METRICS_UNWATCH, (): IPCResult => {
    stopWatchingProjectMetrics();
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_REMOVE,
    async (_, projectId: string): Promise<IPCResult> => {
      const success = projectStore.removeProject(projectId);
      if (success) safeSendToRenderer(getMainWindow, IPC_CHANNELS.PROJECT_LIST_CHANGED);
      return { success };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_LIST,
    async (): Promise<IPCResult<Project[]>> => {
      // Validate that .workbench folders still exist for all projects
      // If a folder was deleted, reset autoBuildPath so UI prompts for reinitialization
      const resetIds = projectStore.validateProjects();
      if (resetIds.length > 0) {
        console.warn('[IPC] PROJECT_LIST: Detected missing .workbench folders for', resetIds.length, 'project(s)');
      }

      const projects = projectStore.getProjects();
      console.warn('[IPC] PROJECT_LIST returning', projects.length, 'projects');
      return { success: true, data: projects };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_UPDATE_SETTINGS,
    async (
      _,
      projectId: string,
      settings: Partial<ProjectSettings>
    ): Promise<IPCResult> => {
      const before = projectStore.getProject(projectId)?.settings.selfImprove === true;
      const project = projectStore.updateProjectSettings(projectId, settings);
      if (!project) return { success: false, error: 'Project not found' };

      // Switching self-improve on or off relocates the project's Claude Code memory, so it takes
      // effect outside the app too. A failure leaves the setting saved but says what went wrong.
      if (settings.selfImprove !== undefined && settings.selfImprove !== before) {
        try {
          if (settings.selfImprove) {
            await applyProjectMemory(project.path);
          } else {
            await removeProjectMemory(project.path);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          appLog.error('[IPC] PROJECT_UPDATE_SETTINGS: self-improve setup failed:', error);
          // Turning it on half way is worse than not turning it on: the nudge would ask sessions to
          // save memories that nothing would read back. Turning it off half way is closer to off,
          // so only this direction is reverted.
          if (settings.selfImprove) projectStore.updateProjectSettings(projectId, { selfImprove: before });
          return { success: false, error: message };
        }
      }
      return { success: true };
    }
  );

  // ============================================
  // Tab State Operations (persisted in main process)
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.TAB_STATE_GET,
    async (): Promise<IPCResult<{ openProjectIds: string[]; activeProjectId: string | null; tabOrder: string[] }>> => {
      const tabState = projectStore.getTabState();
      console.log('[IPC] TAB_STATE_GET returning:', tabState);
      warmOpenProjects(tabState.openProjectIds);
      return { success: true, data: tabState };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TAB_STATE_SAVE,
    async (
      _,
      tabState: { openProjectIds: string[]; activeProjectId: string | null; tabOrder: string[] }
    ): Promise<IPCResult> => {
      console.log('[IPC] TAB_STATE_SAVE called with:', tabState);
      projectStore.saveTabState(tabState);
      warmOpenProjects(tabState.openProjectIds);
      return { success: true };
    }
  );

  // ============================================
  // Kanban Preferences Operations (persisted in main process)
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_PREFS_GET,
    async (_, projectId: string): Promise<IPCResult<Record<string, { width: number; isCollapsed: boolean; isLocked: boolean }> | null>> => {
      try {
        const preferences = projectStore.getKanbanPreferences(projectId);
        return { success: true, data: preferences };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_PREFS_SAVE,
    async (
      _,
      projectId: string,
      preferences: Record<string, { width: number; isCollapsed: boolean; isLocked: boolean }>
    ): Promise<IPCResult> => {
      try {
        projectStore.saveKanbanPreferences(projectId, preferences);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // ============================================
  // Project Initialization Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_INITIALIZE,
    async (_, projectId: string): Promise<IPCResult<InitializationResult>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        const result = await initializeProject(project.path);

        if (result.success) {
          // Update project's autoBuildPath
          projectStore.updateAutoBuildPath(projectId, '.workbench');
          // Live agent is on for newly set up projects (projects set up before keep their choice)
          void setLiveAgentEnabled(project.path, true).catch((error: unknown) => {
            appLog.warn(`[Project] Could not switch Live agent on for ${project.path}:`, error);
          });
        }

        return { success: result.success, data: result, error: result.error };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // PROJECT_CHECK_VERSION now just checks if project is initialized
  // Version tracking for .workbench is removed since it only contains data
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_CHECK_VERSION,
    async (_, projectId: string): Promise<IPCResult<AutoBuildVersionInfo>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        return {
          success: true,
          data: {
            isInitialized: isInitialized(project.path),
            updateAvailable: false // No updates for .workbench - it's just data
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Check if project has local workbench source (is dev project)
  ipcMain.handle(
    'project:has-local-source',
    async (_, projectId: string): Promise<IPCResult<boolean>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }
        return { success: true, data: hasLocalSource(project.path) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // ============================================
  // Git Operations
  // ============================================

  // Get all branches for a project (legacy - returns string[])
  ipcMain.handle(
    IPC_CHANNELS.GIT_GET_BRANCHES,
    async (_, projectPath: string): Promise<IPCResult<string[]>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const branches = await getGitBranches(projectPath);
        return { success: true, data: branches };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Get all branches with structured type information (local vs remote)
  ipcMain.handle(
    IPC_CHANNELS.GIT_GET_BRANCHES_WITH_INFO,
    async (_, projectPath: string, fetchRemote?: boolean): Promise<IPCResult<GitBranchDetail[]>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const branches = await getGitBranchesWithInfo(projectPath, fetchRemote === true);
        return { success: true, data: branches };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Get current branch for a project
  ipcMain.handle(
    IPC_CHANNELS.GIT_GET_CURRENT_BRANCH,
    async (_, projectPath: string): Promise<IPCResult<string | null>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const branch = await getCurrentGitBranch(projectPath);
        return { success: true, data: branch };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Auto-detect main branch for a project
  ipcMain.handle(
    IPC_CHANNELS.GIT_DETECT_MAIN_BRANCH,
    async (_, projectPath: string): Promise<IPCResult<string | null>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const mainBranch = await detectMainBranch(projectPath);
        return { success: true, data: mainBranch };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Check git status for a project (is it a repo? has commits?)
  ipcMain.handle(
    IPC_CHANNELS.GIT_CHECK_STATUS,
    async (_, projectPath: string): Promise<IPCResult<GitStatus>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const gitStatus = await checkGitStatus(projectPath);
        return { success: true, data: gitStatus };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  // Initialize git in a project (run git init and create initial commit)
  ipcMain.handle(
    IPC_CHANNELS.GIT_INITIALIZE,
    async (_, projectPath: string): Promise<IPCResult<InitializationResult>> => {
      try {
        if (!existsSync(projectPath)) {
          return { success: false, error: 'Directory does not exist' };
        }
        const result = await initializeGit(projectPath);
        return { success: result.success, data: result, error: result.error };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );
}
