import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  GitHubRepository,
  GitHubSyncStatus,
  IPCResult
} from '../../../shared/types';
import { createIpcListener, invokeIpc, IpcListenerCleanup } from './ipc-utils';

/**
 * GitHub Integration API operations
 */
export interface GitHubAPI {
  // Operations
  getGitHubRepositories: (projectId: string) => Promise<IPCResult<GitHubRepository[]>>;
  checkGitHubConnection: (projectId: string) => Promise<IPCResult<GitHubSyncStatus>>;

  // OAuth operations (gh CLI)
  checkGitHubCli: () => Promise<IPCResult<{ installed: boolean; version?: string }>>;
  checkGitHubAuth: () => Promise<IPCResult<{ authenticated: boolean; username?: string }>>;
  startGitHubAuth: () => Promise<IPCResult<{ success: boolean; message?: string }>>;
  getGitHubToken: () => Promise<IPCResult<{ token: string }>>;
  getGitHubUser: () => Promise<IPCResult<{ username: string; name?: string }>>;
  listGitHubUserRepos: () => Promise<IPCResult<{ repos: Array<{ fullName: string; description: string | null; isPrivate: boolean }> }>>;

  // OAuth event listener - receives device code immediately when extracted
  onGitHubAuthDeviceCode: (
    callback: (data: { deviceCode: string; authUrl: string; browserOpened: boolean }) => void
  ) => IpcListenerCleanup;

  // OAuth event listener - notifies when GitHub account changes (via gh auth login)
  onGitHubAuthChanged: (
    callback: (data: { oldUsername: string | null; newUsername: string }) => void
  ) => IpcListenerCleanup;

  // Repository detection and management
  detectGitHubRepo: (projectPath: string) => Promise<IPCResult<string>>;
  getGitHubBranches: (repo: string, token: string) => Promise<IPCResult<string[]>>;
  createGitHubRepo: (
    repoName: string,
    options: { description?: string; isPrivate?: boolean; projectPath: string; owner?: string }
  ) => Promise<IPCResult<{ fullName: string; url: string }>>;
  addGitRemote: (
    projectPath: string,
    repoFullName: string
  ) => Promise<IPCResult<{ remoteUrl: string }>>;
  listGitHubOrgs: () => Promise<IPCResult<{ orgs: Array<{ login: string; avatarUrl?: string }> }>>;
}

/**
 * Creates the GitHub Integration API implementation
 */
export const createGitHubAPI = (): GitHubAPI => ({
  // Operations
  getGitHubRepositories: (projectId: string): Promise<IPCResult<GitHubRepository[]>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_GET_REPOSITORIES, projectId),

  checkGitHubConnection: (projectId: string): Promise<IPCResult<GitHubSyncStatus>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_CHECK_CONNECTION, projectId),

  // OAuth operations (gh CLI)
  checkGitHubCli: (): Promise<IPCResult<{ installed: boolean; version?: string }>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_CHECK_CLI),

  checkGitHubAuth: (): Promise<IPCResult<{ authenticated: boolean; username?: string }>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_CHECK_AUTH),

  startGitHubAuth: (): Promise<IPCResult<{ success: boolean; message?: string }>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_START_AUTH),

  getGitHubToken: (): Promise<IPCResult<{ token: string }>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_GET_TOKEN),

  getGitHubUser: (): Promise<IPCResult<{ username: string; name?: string }>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_GET_USER),

  listGitHubUserRepos: (): Promise<IPCResult<{ repos: Array<{ fullName: string; description: string | null; isPrivate: boolean }> }>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_LIST_USER_REPOS),

  // OAuth event listener - receives device code immediately when extracted (during auth process)
  onGitHubAuthDeviceCode: (
    callback: (data: { deviceCode: string; authUrl: string; browserOpened: boolean }) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.GITHUB_AUTH_DEVICE_CODE, callback),

  // OAuth event listener - notifies when GitHub account changes (via gh auth login)
  onGitHubAuthChanged: (
    callback: (data: { oldUsername: string | null; newUsername: string }) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.GITHUB_AUTH_CHANGED, callback),

  // Repository detection and management
  detectGitHubRepo: (projectPath: string): Promise<IPCResult<string>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_DETECT_REPO, projectPath),

  getGitHubBranches: (repo: string, token: string): Promise<IPCResult<string[]>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_GET_BRANCHES, repo, token),

  createGitHubRepo: (
    repoName: string,
    options: { description?: string; isPrivate?: boolean; projectPath: string; owner?: string }
  ): Promise<IPCResult<{ fullName: string; url: string }>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_CREATE_REPO, repoName, options),

  addGitRemote: (
    projectPath: string,
    repoFullName: string
  ): Promise<IPCResult<{ remoteUrl: string }>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_ADD_REMOTE, projectPath, repoFullName),

  listGitHubOrgs: (): Promise<IPCResult<{ orgs: Array<{ login: string; avatarUrl?: string }> }>> =>
    invokeIpc(IPC_CHANNELS.GITHUB_LIST_ORGS),
});
