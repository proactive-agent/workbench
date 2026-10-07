/**
 * GitHub Stores - Focused state management for GitHub integration
 *
 * - Sync Status Store: GitHub connection status
 */

// Sync Status Store
export {
  useSyncStatusStore,
  checkGitHubConnection
} from './sync-status-store';

export type { GitHubSyncStatus } from '../../../shared/types';
