/**
 * Mock implementation for project operations
 */

import { DEFAULT_PROJECT_SETTINGS } from '../../../shared/constants';
import { mockProjects } from './mock-data';

export const projectMock = {
  addProject: async (projectPath: string) => ({
    success: true,
    data: {
      id: `mock-${Date.now()}`,
      name: projectPath.split('/').pop() || 'new-project',
      path: projectPath,
      autoBuildPath: `${projectPath}/workbench`,
      settings: DEFAULT_PROJECT_SETTINGS,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }),

  removeProject: async () => ({ success: true }),

  getProjects: async () => ({
    success: true,
    data: mockProjects
  }),

  getProjectCostMetrics: async () => ({
    success: true,
    data: mockProjects.map((project) => ({
      projectId: project.id,
      name: project.name,
      path: project.path,
      taskCount: 0,
      totalCostUsd: 0,
      daily: []
    }))
  }),

  // Nothing spends in the browser, so there is never a change to report
  watchProjectCostMetrics: async () => ({ success: true }),
  unwatchProjectCostMetrics: async () => ({ success: true }),
  onProjectCostMetricsChanged: () => () => {},

  updateProjectSettings: async () => ({ success: true }),

  initializeProject: async () => ({
    success: true,
    data: { success: true, version: '1.0.0', wasUpdate: false }
  }),

  checkProjectVersion: async () => ({
    success: true,
    data: {
      isInitialized: true,
      currentVersion: '1.0.0',
      sourceVersion: '1.0.0',
      updateAvailable: false
    }
  }),

  // Tab state operations (persisted in main process)
  getTabState: async () => ({
    success: true,
    data: {
      openProjectIds: [],
      activeProjectId: null,
      tabOrder: []
    }
  }),

  saveTabState: async () => ({ success: true }),

  // Kanban Preferences
  getKanbanPreferences: async () => ({ success: true, data: null }),
  saveKanbanPreferences: async () => ({ success: true }),

  // Dialog operations
  selectDirectory: async () => {
    return prompt('Enter project path (browser mock):', '/Users/demo/projects/new-project');
  },

  createProjectFolder: async (_location: string, name: string, initGit: boolean) => ({
    success: true,
    data: {
      path: `/Users/demo/projects/${name}`,
      name,
      gitInitialized: initGit
    }
  }),

  getDefaultProjectLocation: async () => '/Users/demo/projects',

  // Git operations
  getGitBranches: async () => ({
    success: true,
    data: ['main', 'develop', 'feature/test']
  }),

  getGitBranchesWithInfo: async () => ({
    success: true,
    data: [
      { name: 'main', type: 'local' as const, displayName: 'main', isCurrent: true },
      { name: 'develop', type: 'local' as const, displayName: 'develop', isCurrent: false },
      { name: 'feature/test', type: 'local' as const, displayName: 'feature/test', isCurrent: false },
      { name: 'origin/main', type: 'remote' as const, displayName: 'origin/main', isCurrent: false },
      { name: 'origin/develop', type: 'remote' as const, displayName: 'origin/develop', isCurrent: false }
    ]
  }),

  getCurrentGitBranch: async () => ({
    success: true,
    data: 'main'
  }),

  detectMainBranch: async () => ({
    success: true,
    data: 'main'
  }),

  checkGitStatus: async () => ({
    success: true,
    data: {
      isGitRepo: true,
      hasCommits: true,
      currentBranch: 'main'
    }
  }),

  initializeGit: async () => ({
    success: true,
    data: { success: true }
  }),

  onProjectListChanged: () => () => {},

  // Project windows (the browser mock always behaves like a single window)
  assignedProjectId: null,

  listProjectWindows: async () => ({
    success: true,
    data: [{ windowId: 1, projectId: mockProjects[0]?.id ?? null }]
  }),

  reportWindowProject: () => {},

  openProjectWindow: async () => ({ success: true, data: { focused: false } }),

  closeProjectWindow: async () => ({ success: true }),

  onProjectWindowsChanged: () => () => {},

  onWindowCloseRequested: () => () => {},

  chooseWindowClose: async () => ({ success: true })
};
