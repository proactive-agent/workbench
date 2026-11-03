/**
 * Chat browsers
 * =============
 *
 * Each Claude chat has at most one browser, owned by Workbench rather than by a turn, so it stays
 * open between turns, while the user is on other pages or chats, and lets the user and the chat
 * work in the same pages (the user signs in by hand, then asks the chat to carry on).
 *
 * The browser is held by a long-lived Playwright MCP server Workbench starts itself (the
 * "holder"): the same server and browser options a turn would get for the chat's browser choice
 * (its profile copy, headless), with `--idle-timeout 0`. Its MCP client name is the chat's bind
 * title, so the browser it launches is bound in Playwright's registry under that title, with the
 * holder's own folder (outside the project) as its workspace, registered for the chat's project
 * (project-match.ts). A turn's Playwright server gets `--endpoint <title>` and attaches to it
 * (playwright-core's createRemoteBrowser: the registry entry with that title, `contexts()[0]`);
 * attached servers leave it open when the turn ends (the chat's guard refuses `browser_close`,
 * which could close the attached context).
 *
 * The browser opens when the user asks (the drawer's Open browser button) or on a turn's first
 * browser tool call (the chat's Playwright guard asks through the turn's token,
 * `insights-executor.ts`). It closes when the user closes its last tab, the chat is deleted, the
 * browser goes away (it crashed: its registry entry stops answering) or the app quits.
 *
 * Chats are told apart by id within their project; the New chat page (no conversation yet) is
 * NEW_CHAT_BROWSER_ID, and its browser moves to the conversation its first message creates.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import { mkdtemp, realpath, rm } from 'fs/promises';
import type { ChildProcess } from 'child_process';
import type { AppSettings, McpConnectorSettings } from '../../shared/types/settings';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { NEW_CHAT_BROWSER_ID, type ChatBrowserInfo } from '../../shared/types/browser-drawer';
import { getTaskPlaywrightBrowser } from '../../shared/utils/mcp-connectors';
import { appLog } from '../app-logger';
import { buildMcpConfig, MCP_STARTUP_TIMEOUT_MS } from '../claude-code/mcp-config';
import { readSettingsFileAsync } from '../settings-utils';
import { resolveCommand } from '../mcp-commands';
import { getToolEnvAsync } from '../cli-utils';
import { isWindows } from '../platform';
import { killRuntimeProcessTree, spawnTool } from '../platform/runtime-exec';
import { prepareBrowserProfileCopy, removeBrowserProfileCopy } from '../browser-profiles/profile-copy';
import { browserChoicesInUse } from '../browser-profiles/choices-in-use';
import { registerChatBrowserWorkspace } from './project-match';

/** The bind titles of chat browsers start with this */
const CHAT_BROWSER_TITLE_PREFIX = 'Workbench chat ';

/** How long a holder may take to start its browser (npx may download the server first) */
const START_TIMEOUT_MS = MCP_STARTUP_TIMEOUT_MS;
/** How long a holder may take to close its browser and exit before it is stopped */
const CLOSE_TIMEOUT_MS = 5000;

/** A running holder */
export interface ChatBrowserHolder {
  /** Close the browser and stop the holder */
  close: () => Promise<void>;
  /** Called once when the holder exits (closed, crashed or stopped) */
  onExit: (listener: () => void) => void;
}

/** Starts a holder whose browser is bound under `title` (rejects with a readable message) */
export type StartChatBrowserHolder = (options: {
  projectPath: string;
  title: string;
  /** The browser to open (undefined: Settings > Connectors) */
  choice: PlaywrightBrowserChoice | null | undefined;
}) => Promise<ChatBrowserHolder>;

interface Entry {
  projectId: string;
  chatId: string;
  title: string;
  status: 'starting' | 'open';
  starting?: Promise<void>;
  holder?: ChatBrowserHolder;
  /** Its browser has been seen live in Playwright's registry */
  seenLive: boolean;
}

const keyOf = (projectId: string, chatId: string) => `${projectId}\n${chatId}`;

/** Emits 'change' when a chat browser starts, opens or closes */
export class ChatBrowsers extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  /** Bind titles by chat, kept while the app runs: a turn attaches by its chat's title */
  private readonly titles = new Map<string, string>();
  /** Chats whose browser was closed while it started, until that start has ended */
  private readonly closing = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly startHolder: StartChatBrowserHolder = startPlaywrightHolder) {
    super();
  }

  /** The bind title of a chat's browser (the same for the chat while the app runs) */
  titleFor(projectId: string, chatId: string): string {
    const key = keyOf(projectId, chatId);
    let title = this.titles.get(key);
    if (!title) {
      title = `${CHAT_BROWSER_TITLE_PREFIX}${randomUUID()}`;
      this.titles.set(key, title);
    }
    return title;
  }

  /** The chat a bind title belongs to */
  chatOfTitle(title: string): { projectId: string; chatId: string } | undefined {
    if (!title.startsWith(CHAT_BROWSER_TITLE_PREFIX)) return undefined;
    for (const [key, value] of this.titles) {
      if (value !== title) continue;
      const [projectId, chatId] = key.split('\n');
      return { projectId, chatId };
    }
    return undefined;
  }

  /** The chats' browsers being opened or open */
  list(): ChatBrowserInfo[] {
    return [...this.entries.values()].map(({ projectId, chatId, status }) => ({ projectId, chatId, status }));
  }

  isOpen(projectId: string, chatId: string): boolean {
    return this.entries.get(keyOf(projectId, chatId))?.status === 'open';
  }

  /**
   * Open the chat's browser unless it is open or opening (then wait for that). `choice` is the
   * chat's browser (undefined: Settings > Connectors); an open browser keeps the one it opened with
   */
  ensure(projectId: string, projectPath: string, chatId: string, choice: PlaywrightBrowserChoice | null | undefined): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Workbench is quitting'));
    const key = keyOf(projectId, chatId);
    // A browser closed while it started is still going: a new one waits for it (one per title)
    const closing = this.closing.get(key);
    if (closing) return closing.then(() => this.ensure(projectId, projectPath, chatId, choice));
    const existing = this.entries.get(key);
    if (existing?.status === 'open') return Promise.resolve();
    if (existing?.starting) return existing.starting;

    const entry: Entry = { projectId, chatId, title: this.titleFor(projectId, chatId), status: 'starting', seenLive: false };
    this.entries.set(key, entry);
    entry.starting = this.startHolder({ projectPath, title: entry.title, choice }).then(
      async (holder) => {
        entry.starting = undefined;
        // Closed (or the chat deleted, or the app quitting) while it started
        if (this.entries.get(keyOf(entry.projectId, entry.chatId)) !== entry) {
          await holder.close().catch(() => undefined);
          throw new Error('The browser was closed');
        }
        entry.holder = holder;
        entry.status = 'open';
        holder.onExit(() => this.forget(entry));
        this.emit('change');
      },
      (error: unknown) => {
        entry.starting = undefined;
        this.forget(entry);
        throw error instanceof Error ? error : new Error(String(error));
      },
    );
    this.emit('change');
    return entry.starting;
  }

  /** Close a chat's browser (nothing when it has none) */
  async close(projectId: string, chatId: string): Promise<void> {
    const key = keyOf(projectId, chatId);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.forget(entry);
    if (entry.starting) {
      // Still starting: it closes itself once started; until then the chat can't open another
      const done = entry.starting.then(() => undefined, () => undefined).finally(() => {
        if (this.closing.get(key) === done) this.closing.delete(key);
      });
      this.closing.set(key, done);
      await done;
      return;
    }
    await entry.holder?.close();
  }

  /** Close the browsers of chats that were deleted */
  async closeChats(projectId: string, chatIds: readonly string[]): Promise<void> {
    await Promise.all(chatIds.map((chatId) => this.close(projectId, chatId)));
    for (const chatId of chatIds) this.titles.delete(keyOf(projectId, chatId));
  }

  /** The New chat page's browser belongs to the conversation its first message created */
  adopt(projectId: string, toChatId: string, fromChatId = NEW_CHAT_BROWSER_ID): void {
    if (toChatId === fromChatId) return;
    const from = keyOf(projectId, fromChatId);
    const to = keyOf(projectId, toChatId);
    const title = this.titles.get(from);
    if (!title || this.titles.has(to)) return;
    this.titles.set(to, title);
    this.titles.delete(from);
    const entry = this.entries.get(from);
    if (entry) {
      this.entries.delete(from);
      entry.chatId = toChatId;
      this.entries.set(to, entry);
    }
    this.emit('change');
  }

  /**
   * The titles live in Playwright's registry now: an open chat browser seen live before and gone
   * now has crashed or was closed from outside, so its holder stops
   */
  syncLive(liveTitles: ReadonlySet<string>): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.status !== 'open') continue;
      if (liveTitles.has(entry.title)) {
        entry.seenLive = true;
      } else if (entry.seenLive) {
        appLog.info(`[BrowserDrawer] The browser of chat ${entry.chatId} went away; closing it`);
        void this.close(entry.projectId, entry.chatId);
      }
    }
  }

  /** Close every chat browser (the app is quitting) */
  async shutdown(): Promise<void> {
    this.stopped = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.holder?.close()));
  }

  private forget(entry: Entry): void {
    const key = keyOf(entry.projectId, entry.chatId);
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.emit('change');
  }
}

// =============================================================================
// The holder: a Playwright MCP server Workbench talks to over stdio
// =============================================================================

/** The first sentence of a Playwright tool error (its text starts with a `### Error` heading) */
export function holderError(text: string): string {
  const line = text.trim().split('\n').map((l) => l.trim()).find((l) => l && !/^#+\s/.test(l)) ?? '';
  return line.replace(/^Error:\s*/, '').split(/\.\s+(?=[A-Z])/)[0].replace(/\.$/, '') || 'The browser could not be opened';
}

/**
 * The holder's command line: the turn's Playwright server for this browser, kept open. A profile
 * in memory (`--isolated`, without a profile copy) becomes one in the holder's folder instead
 * (`<dir>/profile`, removed with it): a persistent context, which an attached turn's server
 * never closes, and sign-ins made in it last while the browser is open
 */
export function holderArgs(args: readonly string[], dir: string): string[] {
  const profile = path.join(dir, 'profile');
  const own = args.flatMap((arg) => (arg === '--isolated' ? ['--user-data-dir', profile] : [arg]));
  return [...own, '--idle-timeout', '0', '--output-dir', dir];
}

/**
 * Talk MCP to a started holder: initialize as `title`, then open about:blank so the browser
 * launches (and binds). Resolves once it has; answers the server's own requests (ping)
 */
function initializeHolder(proc: ChildProcess, title: string, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('The browser did not start in time')), timeoutMs);
    const send = (message: Record<string, unknown>) => {
      try {
        proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
      } catch {
        // The holder exited; its exit settles
      }
    };
    proc.stdin?.on('error', () => undefined);
    proc.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString('utf-8');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: { id?: unknown; method?: string; result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        // The server's own requests (ping, roots) get an empty answer
        if (message.method && message.id !== undefined) {
          send({ id: message.id, result: message.method === 'roots/list' ? { roots: [] } : {} });
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error(message.error.message ?? 'The browser could not be opened'));
            continue;
          }
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'about:blank' } } });
        } else if (message.id === 2) {
          const failure = message.error?.message
            ?? (message.result?.isError ? message.result.content?.map((part) => part.text ?? '').join(' ') : undefined);
          finish(failure === undefined ? undefined : new Error(holderError(failure)));
        }
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString('utf-8')).slice(-2000);
    });
    proc.once('error', (error) => finish(error));
    proc.once('exit', (code) => {
      const lastLine = stderr.trim().split('\n').filter(Boolean).at(-1);
      finish(new Error(lastLine || `The browser stopped (code ${code ?? 'unknown'})`));
    });
    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: title, version: '1.0.0' } },
    });
  });
}

/** Ask a holder to close its browser (its input ends), and stop it when it doesn't exit in time */
function closeHolderProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killRuntimeProcessTree(proc);
      resolve();
    }, CLOSE_TIMEOUT_MS);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.stdin?.end();
    } catch {
      killRuntimeProcessTree(proc);
    }
  });
}

/** The chosen browser for a chat (undefined: Settings), with the settings a run would use */
function chatRunSettings(settings: McpConnectorSettings | undefined, choice: PlaywrightBrowserChoice | null | undefined): McpConnectorSettings {
  return { ...settings, playwrightBrowser: getTaskPlaywrightBrowser(choice, settings) } as McpConnectorSettings;
}

/** Start a holder for a chat: copy the chosen profile, start the server, open the browser */
const startPlaywrightHolder: StartChatBrowserHolder = async ({ projectPath, title, choice }) => {
  const settings = ((await readSettingsFileAsync()) as Partial<AppSettings> | undefined)?.mcpConnectors;
  const runSettings = chatRunSettings(settings, choice);
  const browser = runSettings.playwrightBrowser;

  const cleanups: Array<() => Promise<void> | void> = [];
  const cleanup = async () => {
    for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
  };
  try {
    // The holder's own folder: its workspace and output folder, registered for the project
    const dir = await mkdtemp(path.join(os.tmpdir(), 'workbench-chat-browser-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    for (const folder of new Set([dir, await realpath(dir).catch(() => dir)])) {
      cleanups.push(registerChatBrowserWorkspace(folder, projectPath));
    }

    let browserProfileDir: string | undefined;
    if (browser && !browser.managed) {
      const inUse = await browserChoicesInUse(projectPath, settings?.playwrightBrowser).catch(() => undefined);
      browserProfileDir = (await prepareBrowserProfileCopy(projectPath, browser, `chat-${randomUUID().slice(0, 8)}`, inUse).catch((error) => {
        appLog.warn('[BrowserDrawer] Could not copy the browser profile for a chat:', error);
        return null;
      })) ?? undefined;
      if (browserProfileDir) {
        const copy = browserProfileDir;
        cleanups.push(() => removeBrowserProfileCopy(copy));
      }
    }

    const entry = buildMcpConfig(['playwright'], runSettings, { browserProfileDir }).mcpServers.playwright;
    if (entry?.type !== 'stdio') throw new Error('Playwright is not available');
    const command = await resolveCommand(entry.command);
    if (!command) throw new Error(`${entry.command} was not found`);
    const proc = spawnTool('python', holderArgs(entry.args ?? [], dir), {
      command,
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(await getToolEnvAsync()), ...entry.env },
      windowsHide: true,
      // Its own process group, so the server npx starts (and its browser) can be stopped with it
      detached: !isWindows(),
    });
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    try {
      await initializeHolder(proc, title);
    } catch (error) {
      await closeHolderProcess(proc);
      throw error;
    }

    const listeners: Array<() => void> = [];
    // Gone (closed, crashed or stopped): its folder, profile copy and registration go too
    const done = exited.then(async () => {
      await cleanup();
      for (const listener of listeners) listener();
    });
    return {
      close: async () => {
        await closeHolderProcess(proc);
        await done;
      },
      onExit: (listener) => {
        listeners.push(listener);
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};
