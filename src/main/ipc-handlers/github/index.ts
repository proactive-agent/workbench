/**
 * GitHub integration IPC handlers
 *
 * Main entry point that registers all GitHub-related handlers.
 * Handlers are organized into modules by functionality:
 * - repository-handlers: Repository and connection management
 * - oauth-handlers: GitHub CLI OAuth authentication and repository setup
 */

import { registerRepositoryHandlers } from './repository-handlers';
import { registerGithubOAuthHandlers } from './oauth-handlers';

/**
 * Register all GitHub-related IPC handlers
 */
export function registerGithubHandlers(): void {
  registerRepositoryHandlers();
  registerGithubOAuthHandlers();
}

// Re-export utilities for potential external use
export { getGitHubConfig, githubFetch } from './utils';
export type { GitHubConfig } from './types';
