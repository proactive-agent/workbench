/**
 * GitLab Merge Requests UI Components
 *
 * Integrated into sidebar and App.tsx.
 * Accessible via the 'gitlab-merge-requests' view.
 */

// Main export for the gitlab-merge-requests module
export { GitLabMergeRequests } from './GitLabMergeRequests';

// Re-export components for external usage if needed
export {
  MergeRequestList,
  MergeRequestItem,
  CreateMergeRequestDialog
} from './components';
