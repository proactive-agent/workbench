/**
 * Types for Electron app auto-update functionality
 */

export interface AppUpdateInfo {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

/**
 * Outcome of an app update check. "up-to-date" is only reported when the newest published release
 * is this exact version; anything that can't be confirmed is reported as such.
 * - update-available: a newer release is published (see `update`)
 * - up-to-date: the newest published release is the running version
 * - unpublished: no published release was found, the running version is newer than every
 *   published release, or this is a development build
 * - error: the check failed (e.g. offline)
 */
export type AppUpdateCheckStatus = 'update-available' | 'up-to-date' | 'unpublished' | 'error';

export interface AppUpdateCheckResult {
  status: AppUpdateCheckStatus;
  /** The newer release, when status is update-available */
  update?: AppUpdateInfo;
  /** Newest published version, when one was found */
  latestVersion?: string;
  /** Failure reason, when status is error */
  error?: string;
}

export interface AppUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
}

export interface AppUpdateAvailableEvent {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface AppUpdateDownloadedEvent {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface AppUpdateErrorEvent {
  message: string;
}
