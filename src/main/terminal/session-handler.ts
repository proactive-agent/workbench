/**
 * Session Handler Module
 * Manages terminal session persistence, restoration, and Claude session tracking
 */

import type { TerminalProcess } from './types';
import { getTerminalSessionStore, flushTerminalSessionStores, type TerminalSession } from '../terminal-session-store';
import { debugError } from '../../shared/utils/debug-logger';

/**
 * Create a TerminalSession object from a TerminalProcess.
 * Shared helper used by both persistSession and persistSessionAsync.
 */
function createSessionObject(terminal: TerminalProcess): TerminalSession {
  return {
    id: terminal.id,
    title: terminal.title,
    cwd: terminal.cwd,
    projectPath: terminal.projectPath!,
    isCLIMode: terminal.isCLIMode,
    outputBuffer: terminal.outputBuffer,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    worktreeConfig: terminal.worktreeConfig,
  };
}

/**
 * Persist a terminal session to disk
 */
export function persistSession(terminal: TerminalProcess): void {
  if (!terminal.projectPath) {
    return;
  }

  const store = getTerminalSessionStore(terminal.projectPath);
  store.saveSession(createSessionObject(terminal));
}

/**
 * Persist a terminal session to disk asynchronously (fire-and-forget).
 * This is non-blocking and prevents the main process from freezing during disk writes.
 */
export function persistSessionAsync(terminal: TerminalProcess): void {
  if (!terminal.projectPath) {
    return;
  }

  const store = getTerminalSessionStore(terminal.projectPath);
  store.saveSessionAsync(createSessionObject(terminal)).catch((error) => {
    debugError('[SessionHandler] Failed to persist session:', error);
  });
}

/**
 * Persist all active sessions asynchronously
 *
 * Uses async persistence to avoid blocking the main process when saving
 * multiple sessions (e.g., on app quit).
 */
export async function persistAllSessionsAsync(terminals: Map<string, TerminalProcess>): Promise<void> {
  const savePromises: Promise<void>[] = [];
  terminals.forEach((terminal) => {
    if (terminal.projectPath) {
      const store = getTerminalSessionStore(terminal.projectPath);
      savePromises.push(store.saveSessionAsync(createSessionObject(terminal)));
    }
  });

  await Promise.all(savePromises);
}

/**
 * Wait until every session saved so far is on disk.
 *
 * Saves are queued, so the app quitting has to wait for the queue: without this the last window a
 * user closed can stay in the file and come back on the next start.
 */
export async function flushSessions(): Promise<void> {
  await flushTerminalSessionStores();
}

/**
 * Clear a terminal ID from pendingDelete, allowing session saves to proceed.
 *
 * Must be called when re-creating a terminal with a previously-used ID
 * (e.g., worktree switching, terminal restart after shell exit). Without this,
 * the pendingDelete guard blocks persistence for the new terminal.
 */
export function clearPendingDelete(projectPath: string, terminalId: string): void {
  getTerminalSessionStore(projectPath).clearPendingDelete(terminalId);
}

/**
 * Remove a session from persistent storage
 */
export function removePersistedSession(terminal: TerminalProcess): void {
  if (!terminal.projectPath) {
    return;
  }

  const store = getTerminalSessionStore(terminal.projectPath);
  store.removeSession(terminal.id);
}

/**
 * Get saved sessions for a project
 */
export function getSavedSessions(projectPath: string): TerminalSession[] {
  return getTerminalSessionStore(projectPath).getSessions();
}

/**
 * Clear all saved sessions for a project
 */
export function clearSavedSessions(projectPath: string): void {
  getTerminalSessionStore(projectPath).clearProjectSessions();
}

/**
 * Update display orders for terminals after drag-drop reorder
 */
export function updateDisplayOrders(
  projectPath: string,
  orders: Array<{ terminalId: string; displayOrder: number }>
): void {
  getTerminalSessionStore(projectPath).updateDisplayOrders(orders);
}
