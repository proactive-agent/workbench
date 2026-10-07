/**
 * GitHub integration IPC handlers
 *
 * This file serves as the main entry point for GitHub-related handlers.
 * All handler implementations have been modularized into the github/ subdirectory.
 *
 * Module organization:
 * - github/repository-handlers.ts - Repository and connection management
 * - github/oauth-handlers.ts - GitHub CLI OAuth authentication and repository setup
 * - github/utils.ts - Shared utility functions
 * - github/types.ts - TypeScript type definitions
 */

import { registerGithubHandlers as registerModularHandlers } from './github';

/**
 * Register all GitHub-related IPC handlers
 */
export function registerGithubHandlers(): void {
  registerModularHandlers();
}
