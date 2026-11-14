/**
 * Chat browsers after a crash
 * ===========================
 *
 * A chat's browser (chat-browsers.ts) keeps a record in its folder in the system temp folder
 * (CHAT_BROWSER_RECORD): its project and chat, the browser it opened, its profile copy and its
 * open tabs, kept current while it runs. Closing it or quitting removes the folder, so a folder
 * that is still there and whose Workbench process no longer runs was left by a crash or a kill.
 *
 * At startup, before profile copies are swept, scanChatBrowserLeftovers looks at those folders: one
 * whose chat still exists (its conversation in the project's `.workbench/chats`) and that is
 * younger than RESTORE_MAX_AGE_MS is kept for that chat (this process takes over its folder and its
 * profile copy, so no sweep removes them, and quitting leaves them). The next time the chat's
 * browser opens with the same browser, it starts from that profile (its sign-ins) and reopens the
 * tabs. Everything else goes, with its profile copy. Only the newest folder of a chat is kept.
 */

import path from 'path';
import { readdir, readFile, rm, stat } from 'fs/promises';
import { appLog } from '../app-logger';
import { claimFolder, folderClaim, releaseFolder, UNVERIFIED_OWNER_AGE_MS, writeOwner } from '../folder-owner';
import { tempFolderParents, TEMP_FOLDER_PREFIXES } from '../temp-folders';
import { isBrowserProfileCopyPath, keepBrowserProfileCopy, removeBrowserProfileCopy } from '../browser-profiles/profile-copy';
import { InsightsPaths } from '../insights/paths';

/** The record in a chat browser's folder */
export const CHAT_BROWSER_RECORD = '.workbench-chat-browser.json';
/** A chat browser left by a crash is kept for its chat this long (from its last change) */
export const RESTORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ChatBrowserTab {
  url: string;
  title: string;
}

/** What a chat browser's folder records about it */
export interface ChatBrowserRecord {
  projectId: string;
  projectPath: string;
  chatId: string;
  /** The browser it opened (a profile id; null: Playwright's own Chromium) */
  browserId: string | null;
  /** Its profile copy (host path), or null (Playwright's own browsers keep their profile in the folder) */
  profileCopyDir: string | null;
  tabs: ChatBrowserTab[];
  /** When it last changed (ms) */
  updatedAt: number;
}

/** A chat browser left by a crash, kept for its chat */
export interface RestorableChatBrowser {
  /** Its folder (host path) */
  dir: string;
  record: ChatBrowserRecord;
}

/** A record read from its file, or null when it isn't one */
export function parseChatBrowserRecord(text: string): ChatBrowserRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const value = raw as Partial<ChatBrowserRecord> | null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.projectId !== 'string' || typeof value.projectPath !== 'string' || typeof value.chatId !== 'string') return null;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null;
  const tabs = Array.isArray(value.tabs)
    ? value.tabs.filter((tab): tab is ChatBrowserTab => !!tab && typeof tab.url === 'string' && typeof tab.title === 'string')
    : [];
  return {
    projectId: value.projectId,
    projectPath: value.projectPath,
    chatId: value.chatId,
    browserId: typeof value.browserId === 'string' ? value.browserId : null,
    profileCopyDir: typeof value.profileCopyDir === 'string' ? value.profileCopyDir : null,
    tabs,
    updatedAt: value.updatedAt,
  };
}

/** The tabs worth opening again (blank ones open as the browser starts anyway) */
export function tabsToRestore(tabs: readonly ChatBrowserTab[]): ChatBrowserTab[] {
  return tabs.filter((tab) => /^(https?|file):/i.test(tab.url));
}

/** Whether a left record's chat browser is kept for its chat */
export function keepsForChat(
  record: ChatBrowserRecord | null,
  context: { now: number; projectPath: string | undefined; chatExists: boolean },
): boolean {
  if (!record || !context.projectPath || !context.chatExists) return false;
  return context.now - record.updatedAt < RESTORE_MAX_AGE_MS;
}

/** Whether a chat's conversation is saved in its project */
export async function conversationExists(projectPath: string, chatId: string): Promise<boolean> {
  try {
    return (await stat(new InsightsPaths().getSessionPath(projectPath, chatId))).isFile();
  } catch {
    // No such file, or not a conversation id (the New chat page's browser)
    return false;
  }
}

interface ChatBrowserScanOptions {
  /** The app's projects */
  projects: ReadonlyArray<{ id: string; path: string }>;
  /** The temp folder (tests) */
  parent?: string;
  now?: number;
  chatExists?: (projectPath: string, chatId: string) => Promise<boolean>;
}

/** Remove a left chat browser's folder and its profile copy (unless another running Workbench holds the copy) */
async function removeLeftover(dir: string, record: ChatBrowserRecord | null): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch((error: unknown) => {
    appLog.warn(`[BrowserDrawer] Could not remove ${dir}:`, error);
  });
  const copy = record?.profileCopyDir;
  // Only a real profile copy's folder (the record could name any folder)
  if (copy && isBrowserProfileCopyPath(copy) && (await folderClaim(copy)) === 'gone') await removeBrowserProfileCopy(copy);
}

/**
 * At startup: keep the chat browsers left by a crash for their chats (taking over their folders
 * and profile copies) and remove the other leftovers. Run before profile copies are swept. Best effort
 */
export async function scanChatBrowserLeftovers(options: ChatBrowserScanOptions): Promise<RestorableChatBrowser[]> {
  const parents = options.parent ? [options.parent] : await tempFolderParents();
  const now = options.now ?? Date.now();
  const chatExists = options.chatExists ?? conversationExists;
  // In each temp folder (WSL mode: also the distribution's, where chat browsers run)
  const dirs: string[] = [];
  for (const parent of parents) {
    try {
      const names = (await readdir(parent)).filter((name) => name.startsWith(TEMP_FOLDER_PREFIXES.chatBrowser));
      dirs.push(...names.map((name) => path.join(parent, name)));
    } catch {
      // No such folder
    }
  }

  // The left folders with their records, newest first
  const left: Array<{ dir: string; record: ChatBrowserRecord | null }> = [];
  for (const dir of dirs) {
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      // Another running Workbench's (or this one's, opened meanwhile), or one being set up
      if ((await folderClaim(dir, UNVERIFIED_OWNER_AGE_MS)) !== 'gone') continue;
      const text = await readFile(path.join(dir, CHAT_BROWSER_RECORD), 'utf-8').catch(() => '');
      left.push({ dir, record: parseChatBrowserRecord(text) });
    } catch {
      // Gone meanwhile
    }
  }
  left.sort((a, b) => (b.record?.updatedAt ?? 0) - (a.record?.updatedAt ?? 0));

  const restorable: RestorableChatBrowser[] = [];
  const chatsKept = new Set<string>();
  for (const { dir, record } of left) {
    const project = record ? options.projects.find((p) => p.id === record.projectId) : undefined;
    const chatKey = record ? `${record.projectId}\n${record.chatId}` : '';
    const keep = !!record && !chatsKept.has(chatKey) && keepsForChat(record, {
      now,
      projectPath: project?.path,
      chatExists: project ? await chatExists(project.path, record.chatId) : false,
    });
    if (!keep || !record || !project) {
      await removeLeftover(dir, record);
      continue;
    }
    try {
      // This process's now: no sweep (of this or another Workbench) removes it
      await writeOwner(dir);
      claimFolder(dir);
    } catch (error) {
      appLog.warn(`[BrowserDrawer] Could not keep ${dir} for its chat:`, error);
      continue;
    }
    // Its sign-ins; without the copy, the chat's browser starts from a new copy (the tabs still come back)
    const copy = record.profileCopyDir && isBrowserProfileCopyPath(record.profileCopyDir) && (await keepBrowserProfileCopy(record.profileCopyDir))
      ? record.profileCopyDir
      : null;
    chatsKept.add(chatKey);
    restorable.push({ dir, record: { ...record, projectPath: project.path, profileCopyDir: copy } });
  }
  if (restorable.length > 0) appLog.info(`[BrowserDrawer] ${restorable.length} chat browser(s) left by a crash kept for their chats`);
  return restorable;
}

/** Remove a kept chat browser that won't be opened again (its chat was deleted, or it opens anew) */
export async function discardRestorable(restorable: RestorableChatBrowser): Promise<void> {
  releaseFolder(restorable.dir);
  await rm(restorable.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
  // Kept by this process (scanChatBrowserLeftovers checked it is a profile copy)
  if (restorable.record.profileCopyDir) await removeBrowserProfileCopy(restorable.record.profileCopyDir);
}
