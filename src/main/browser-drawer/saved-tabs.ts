/**
 * The tabs each chat's browser had open when it closed (the drawer's Close browser, the app
 * quitting, the browser going away), opened again the next time that chat's browser opens. Kept in
 * `<userData>/chat-browser-tabs.json` by project and chat (owner-only, like the crash records, since
 * addresses can carry sign-in codes), written whole through a temp file. A chat that is deleted,
 * whose last tab the user closed, or that is gone at startup (its project removed, its chat file
 * deleted) keeps none.
 *
 * The file is read in the background when the app starts (never on an IPC call): changes made
 * before that are applied on top of what it holds.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import path from 'path';
import { appLog } from '../app-logger';
import type { ChatBrowserTab } from './chat-browser-restore';

type SavedTabsFile = Record<string, Record<string, ChatBrowserTab[]>>;

const FILE_MODE = 0o600;

const isTab = (value: unknown): value is ChatBrowserTab =>
  !!value && typeof (value as ChatBrowserTab).url === 'string' && typeof (value as ChatBrowserTab).title === 'string';

/** The kept tabs a file's text holds (anything else in it is left out) */
function parse(text: string): SavedTabsFile {
  const data: SavedTabsFile = {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') return data;
  for (const [projectId, chats] of Object.entries(parsed as Record<string, unknown>)) {
    if (!chats || typeof chats !== 'object') continue;
    for (const [chatId, tabs] of Object.entries(chats as Record<string, unknown>)) {
      if (Array.isArray(tabs) && tabs.length > 0 && tabs.every(isTab)) (data[projectId] ??= {})[chatId] = tabs;
    }
  }
  return data;
}

const tempPath = (file: string) => path.join(path.dirname(file), `.${path.basename(file)}.tmp.${randomBytes(6).toString('hex')}`);

export class SavedChatTabs {
  private data: SavedTabsFile = {};
  private loaded = false;
  /** Changes made before the file was read, applied again on top of it */
  private early: Array<(data: SavedTabsFile) => void> = [];
  private writing: Promise<void> = Promise.resolve();
  /** Resolves once the file has been read (whatever it held) */
  readonly ready: Promise<void>;

  /** `file`: where they are kept (null: in memory only) */
  constructor(private readonly file: () => string | null) {
    const at = file();
    this.ready = at
      ? readFile(at, 'utf-8').then(
          (text) => this.takeFile(() => parse(text)),
          (error: NodeJS.ErrnoException) => this.takeFile(() => {
            if (error.code !== 'ENOENT') appLog.warn('[BrowserDrawer] Could not read the chat browsers\' kept tabs:', error);
            return {};
          }),
        )
      : Promise.resolve(this.takeFile(() => ({})));
  }

  private takeFile(read: () => SavedTabsFile): void {
    let data: SavedTabsFile;
    try {
      data = read();
    } catch (error) {
      appLog.warn('[BrowserDrawer] The chat browsers\' kept tabs could not be read; starting over:', error);
      data = {};
    }
    const early = this.early;
    this.early = [];
    for (const change of early) change(data);
    this.data = data;
    this.loaded = true;
    if (early.length > 0) this.write();
  }

  /** Change the kept tabs, now and (until the file was read) again on top of it */
  private change(apply: (data: SavedTabsFile) => void): void {
    apply(this.data);
    if (!this.loaded) this.early.push(apply);
    else this.write();
  }

  get(projectId: string, chatId: string): ChatBrowserTab[] {
    return this.data[projectId]?.[chatId] ?? [];
  }

  /** The chats that have tabs to open again, with how many */
  list(): Array<{ projectId: string; chatId: string; tabs: number }> {
    return Object.entries(this.data).flatMap(([projectId, chats]) =>
      Object.entries(chats).map(([chatId, tabs]) => ({ projectId, chatId, tabs: tabs.length })),
    );
  }

  /** Keep a chat's tabs (none: forget them) */
  set(projectId: string, chatId: string, tabs: readonly ChatBrowserTab[]): void {
    const kept = tabs.map(({ url, title }) => ({ url, title }));
    this.change((data) => {
      if (kept.length > 0) (data[projectId] ??= {})[chatId] = kept;
      else if (data[projectId]) {
        delete data[projectId][chatId];
        if (Object.keys(data[projectId]).length === 0) delete data[projectId];
      }
    });
  }

  /** A chat's tabs belong to another chat (the New chat page's, to the conversation it created) */
  move(projectId: string, fromChatId: string, toChatId: string): void {
    const tabs = this.get(projectId, fromChatId);
    if (tabs.length === 0) return;
    this.set(projectId, fromChatId, []);
    this.set(projectId, toChatId, tabs);
  }

  /** Forget the tabs of chats that are gone (their project removed, their chat deleted outside the app) */
  async prune(keep: (projectId: string, chatId: string) => Promise<boolean>): Promise<number> {
    await this.ready;
    let removed = 0;
    for (const { projectId, chatId } of this.list()) {
      if (await keep(projectId, chatId).catch(() => true)) continue;
      this.set(projectId, chatId, []);
      removed++;
    }
    return removed;
  }

  private write(): void {
    const file = this.file();
    if (!file) return;
    this.writing = this.writing
      .then(async () => {
        // What they are by now (a quit's flush may have written newer ones meanwhile)
        const text = JSON.stringify(this.data);
        await mkdir(path.dirname(file), { recursive: true });
        const temp = tempPath(file);
        try {
          await writeFile(temp, text, { encoding: 'utf-8', mode: FILE_MODE });
          await rename(temp, file);
          await chmod(file, FILE_MODE).catch(() => undefined);
        } catch (error) {
          await unlink(temp).catch(() => undefined);
          throw error;
        }
      })
      .catch((error: unknown) => appLog.warn('[BrowserDrawer] Could not keep the chat browsers\' tabs:', error));
  }

  /** Written now, whole (the app is quitting; writes still queued then find the same content) */
  flushSync(): void {
    const file = this.file();
    if (!file) return;
    // Not read yet: what the file holds comes first, the changes on top
    if (!this.loaded) {
      this.takeFile(() => (existsSync(file) ? parse(readFileSync(file, 'utf-8')) : {}));
    }
    const temp = tempPath(file);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(temp, JSON.stringify(this.data), { encoding: 'utf-8', mode: FILE_MODE });
      renameSync(temp, file);
      try {
        chmodSync(file, FILE_MODE);
      } catch {
        // Windows keeps its own permissions
      }
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // Nothing was written
      }
      appLog.warn('[BrowserDrawer] Could not keep the chat browsers\' tabs:', error);
    }
  }
}
