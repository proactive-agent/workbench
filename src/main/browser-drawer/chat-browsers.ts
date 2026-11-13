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
 *
 * In WSL mode the holder runs inside the distribution (spawnTool, like every MCP server there),
 * its folder in the distribution's own temp folder (runtimeTempParent), so the browser's profile
 * isn't on a Windows drive. Settings > Browser > Browser runtime can run chat browsers on Windows
 * instead (browser-runtime.ts): the holder then starts natively (runNatively), with Windows'
 * Node.js and the chat's choice as its Windows profile.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import path from 'path';
import { realpath, stat, writeFile } from 'fs/promises';
import type { ChildProcess } from 'child_process';
import type { AppSettings, McpConnectorSettings } from '../../shared/types/settings';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { NEW_CHAT_BROWSER_ID, type BrowserExtension, type BrowserExtensions, type ChatBrowserInfo } from '../../shared/types/browser-drawer';
import { getTaskPlaywrightBrowser } from '../../shared/utils/mcp-connectors';
import { appLog } from '../app-logger';
import { buildMcpConfig, MCP_STARTUP_TIMEOUT_MS } from '../claude-code/mcp-config';
import { readSettingsFileAsync } from '../settings-utils';
import { resolveCommand } from '../mcp-commands';
import { getToolEnvAsync } from '../cli-utils';
import { isWindows } from '../platform';
import { getWslInfo, runInSessionRuntime } from '../platform/shell-runtime';
import { registryAccess, registryOs, removeClosedSessions } from './registry';
import { killRuntimeProcessTree, spawnTool } from '../platform/runtime-exec';
import { prepareBrowserProfileCopy, removeBrowserProfileCopy, setBrowserProfileCopyExtensions, useKeptBrowserProfileCopy } from '../browser-profiles/profile-copy';
import {
  applyFirefoxExtensionSwitches,
  chromiumExtensionsCode,
  firefoxExtensionTarget,
  type FirefoxExtensionTarget,
  parseChromiumExtensions,
  readFirefoxExtensions,
  type ExtensionSwitches,
} from '../browser-profiles/extensions';
import { makeTempFolder, removeTempFolder, runtimeTempParent, TEMP_FOLDER_PREFIXES } from '../temp-folders';
import {
  CHAT_BROWSER_RECORD,
  discardRestorable,
  tabsToRestore,
  type ChatBrowserRecord,
  type ChatBrowserTab,
  type RestorableChatBrowser,
} from './chat-browser-restore';
import { browserChoicesInUse } from '../browser-profiles/choices-in-use';
import { registerChatBrowserWorkspace } from './project-match';
import { inChatBrowserRuntime, whenChatBrowserRuntimeReady, windowsBrowserChoice, windowsNode, withWindowsNodeOnPath } from './browser-runtime';

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
  /** Keep its record current (the chat it belongs to, its open tabs), for a restart after a crash */
  updateRecord?: (patch: Partial<Pick<ChatBrowserRecord, 'chatId' | 'tabs'>>) => void;
  /** The browser it opened (null: Playwright's own Chromium), whose icon the drawer's tabs show */
  browser?: PlaywrightBrowserChoice | null;
  /**
   * Its profile's extensions (null: it runs none), after switching on or off the ones `switches`
   * names where the browser can while it runs (Chromium; Firefox reads them at start)
   */
  extensions?: (switches?: ExtensionSwitches) => Promise<BrowserExtensions | null>;
  /** Firefox: where an extension's toolbar button leads (its popup's page, else its homepage) */
  extensionTarget?: (extensionId: string) => Promise<FirefoxExtensionTarget>;
  /** Close the browser but keep its folder, profile copy and tabs, to start it again from them */
  suspend?: () => Promise<RestorableChatBrowser>;
}

/** Starts a holder whose browser is bound under `title` (rejects with a readable message) */
export type StartChatBrowserHolder = (options: {
  projectPath: string;
  title: string;
  /** The browser to open (undefined: Settings > Browser) */
  choice: PlaywrightBrowserChoice | null | undefined;
  projectId?: string;
  chatId?: string;
  /** The chat's browser left by a crash: started from its profile and tabs when it is the same browser */
  restore?: RestorableChatBrowser;
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
  /** Chats' browsers left by a crash, opened again from their profile and tabs (chat-browser-restore.ts) */
  private readonly restorables = new Map<string, RestorableChatBrowser>();
  private stopped = false;

  constructor(
    private readonly startHolder: StartChatBrowserHolder = startChatBrowserHolder,
    private readonly discard: (restorable: RestorableChatBrowser) => Promise<void> = discardRestorable,
  ) {
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

  /**
   * The chat a bind title belongs to, with the browser its holder opened (undefined while it starts;
   * null: Playwright's own Chromium)
   */
  chatOfTitle(title: string): { projectId: string; chatId: string; browser?: PlaywrightBrowserChoice | null } | undefined {
    if (!title.startsWith(CHAT_BROWSER_TITLE_PREFIX)) return undefined;
    for (const [key, value] of this.titles) {
      if (value !== title) continue;
      const [projectId, chatId] = key.split('\n');
      const browser = this.entries.get(key)?.holder?.browser;
      return { projectId, chatId, ...(browser !== undefined ? { browser } : {}) };
    }
    return undefined;
  }

  /** The chats' browsers being opened or open */
  list(): ChatBrowserInfo[] {
    const open = [...this.entries.values()].map(({ projectId, chatId, status }): ChatBrowserInfo => ({ projectId, chatId, status }));
    const restorable = [...this.restorables.entries()]
      .filter(([key]) => !this.entries.has(key))
      .map(([, { record }]): ChatBrowserInfo => ({
        projectId: record.projectId,
        chatId: record.chatId,
        status: 'restorable',
        tabs: tabsToRestore(record.tabs).length,
      }));
    return [...open, ...restorable];
  }

  /**
   * A chat's browser left by a crash: kept until the chat's browser opens again (or the chat is
   * deleted). Removed at once when the chat has a browser already (opened while the leftovers were looked at)
   */
  addRestorable(restorable: RestorableChatBrowser): void {
    const key = keyOf(restorable.record.projectId, restorable.record.chatId);
    const previous = this.restorables.get(key);
    if (this.stopped || this.entries.has(key) || (previous && previous.dir !== restorable.dir)) {
      void this.discard(restorable);
      return;
    }
    this.restorables.set(key, restorable);
    this.emit('change');
  }

  /** A chat's open tabs (from the drawer's bridge), kept in its record */
  noteTabs(projectId: string, chatId: string, tabs: ChatBrowserTab[]): void {
    this.entries.get(keyOf(projectId, chatId))?.holder?.updateRecord?.({ tabs });
  }

  isOpen(projectId: string, chatId: string): boolean {
    return this.entries.get(keyOf(projectId, chatId))?.status === 'open';
  }

  /**
   * Open the chat's browser unless it is open or opening (then wait for that). `choice` is the
   * chat's browser (undefined: Settings > Browser); an open browser keeps the one it opened with
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
    // Left by a crash: the holder starts from it, or removes it when the chat's browser changed
    const restore = this.restorables.get(key);
    this.restorables.delete(key);
    entry.starting = this.startHolder({ projectPath, title: entry.title, choice, projectId, chatId, restore }).then(
      (holder) => this.started(entry, holder),
      (error: unknown) => this.failed(entry, error, restore),
    );
    this.emit('change');
    return entry.starting;
  }

  /**
   * Start a chat's open browser again from its profile copy and tabs (what it reads at start, such
   * as Firefox's extension switches, then applies). Nothing when it isn't open
   */
  restart(projectId: string, chatId: string): Promise<void> {
    const entry = this.entries.get(keyOf(projectId, chatId));
    const holder = entry?.holder;
    if (!entry || entry.status !== 'open' || !holder?.suspend) return Promise.resolve();
    const suspend = holder.suspend;
    entry.holder = undefined;
    entry.status = 'starting';
    entry.seenLive = false;
    let restore: RestorableChatBrowser | undefined;
    entry.starting = suspend()
      .then((kept) => {
        restore = kept;
        return this.startHolder({
          projectPath: kept.record.projectPath,
          title: entry.title,
          choice: holder.browser,
          projectId: entry.projectId,
          chatId: entry.chatId,
          restore: kept,
        });
      })
      .then((next) => this.started(entry, next), (error: unknown) => this.failed(entry, error, restore));
    this.emit('change');
    return entry.starting;
  }

  /** A holder started for the entry */
  private async started(entry: Entry, holder: ChatBrowserHolder): Promise<void> {
    entry.starting = undefined;
    // Closed (or the chat deleted, or the app quitting) while it started
    if (this.entries.get(keyOf(entry.projectId, entry.chatId)) !== entry) {
      await holder.close().catch(() => undefined);
      throw new Error('The browser was closed');
    }
    entry.holder = holder;
    entry.status = 'open';
    // The New chat page's browser may have moved to its conversation while it started
    holder.updateRecord?.({ chatId: entry.chatId });
    // A holder suspended for a restart exits while the entry waits for the next one
    holder.onExit(() => {
      if (entry.holder === holder) this.forget(entry);
    });
    this.emit('change');
  }

  /** The entry's holder didn't start: a browser it was to open again stays to open again */
  private failed(entry: Entry, error: unknown, restore: RestorableChatBrowser | undefined): never {
    entry.starting = undefined;
    const key = keyOf(entry.projectId, entry.chatId);
    // A failed start keeps what it was to open again (its folder is left as it was)
    if (restore && !this.stopped && !this.restorables.has(key)) {
      void stat(restore.dir).then(() => {
        if (!this.restorables.has(key) && !this.entries.has(key)) {
          this.restorables.set(key, restore);
          this.emit('change');
        }
      }, () => undefined);
    }
    this.forget(entry);
    throw error instanceof Error ? error : new Error(String(error));
  }

  /** The holder of a chat browser bound under a title (open ones only) */
  holderOfTitle(title: string): ChatBrowserHolder | undefined {
    for (const entry of this.entries.values()) {
      if (entry.title === title && entry.status === 'open') return entry.holder;
    }
    return undefined;
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
    for (const chatId of chatIds) {
      const key = keyOf(projectId, chatId);
      const restorable = this.restorables.get(key);
      if (!restorable) continue;
      this.restorables.delete(key);
      void this.discard(restorable);
      this.emit('change');
    }
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
      entry.holder?.updateRecord?.({ chatId: toChatId });
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

  /** Close every chat browser (the app is quitting; browsers left by a crash stay for the next start) */
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

/** A JSON-RPC client over a holder's stdio (answers the server's own requests: ping, roots) */
interface HolderClient {
  request: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<HolderReply>;
  notify: (method: string) => void;
  /** Rejects when the holder exits, with its last error line */
  exited: Promise<never>;
}

interface HolderReply {
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
  error?: { message?: string };
}

function holderClient(proc: ChildProcess): HolderClient {
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map<number, (reply: HolderReply) => void>();
  const write = (message: Record<string, unknown>) => {
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
      let message: HolderReply & { id?: unknown; method?: string };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // The server's own requests (ping, roots) get an empty answer
      if (message.method && message.id !== undefined) {
        write({ id: message.id, result: message.method === 'roots/list' ? { roots: [] } : {} });
        continue;
      }
      if (typeof message.id === 'number') {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });
  proc.stderr?.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString('utf-8')).slice(-2000);
  });
  const exited = new Promise<never>((_, reject) => {
    const fail = (error: Error) => reject(error);
    proc.once('error', fail);
    proc.once('exit', (code) => {
      const lastLine = stderr.trim().split('\n').filter(Boolean).at(-1);
      fail(new Error(lastLine || `The browser stopped (code ${code ?? 'unknown'})`));
    });
  });
  exited.catch(() => undefined);
  return {
    request: (method, params, timeoutMs) => {
      const id = nextId++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reply = new Promise<HolderReply>((resolve, reject) => {
        pending.set(id, resolve);
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The browser did not start in time'));
        }, timeoutMs);
        write({ id, method, params });
      });
      return Promise.race([reply, exited]).finally(() => clearTimeout(timer));
    },
    notify: (method) => write({ method }),
    exited,
  };
}

/** A tool call's failure, as text (undefined: it worked) */
function replyFailure(reply: HolderReply): string | undefined {
  return reply.error?.message ?? (reply.result?.isError ? reply.result.content?.map((part) => part.text ?? '').join(' ') : undefined);
}

/**
 * Talk MCP to a started holder: initialize as `title`, then open about:blank so the browser
 * launches (and binds). Resolves once it has
 */
async function initializeHolder(client: HolderClient, title: string, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  // One deadline for the whole start, not one per request
  const deadline = Date.now() + timeoutMs;
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: title, version: '1.0.0' },
  }, timeoutMs);
  if (init.error) throw new Error(init.error.message ?? 'The browser could not be opened');
  client.notify('notifications/initialized');
  const opened = await client.request(
    'tools/call',
    { name: 'browser_navigate', arguments: { url: 'about:blank' } },
    Math.max(0, deadline - Date.now()),
  );
  const failure = replyFailure(opened);
  if (failure !== undefined) throw new Error(holderError(failure));
}

/** Whether chat browsers run the extensions installed in their browser profile (Settings > Browser) */
export function chatBrowserExtensions(settings: Partial<AppSettings> | undefined): boolean {
  return settings?.browser?.extensions === true;
}

/** The homepage a new chat browser opens, when it is an address the drawer opens */
export function homepageUrl(homepage: string | undefined): string | undefined {
  const url = homepage?.trim();
  return url && /^(https?|about|file):/i.test(url) && url !== 'about:blank' ? url : undefined;
}

/** How long reopening one saved tab may take */
const RESTORE_TAB_TIMEOUT_MS = 30_000;

/** Open pages in a started browser (a crashed one's tabs, or the homepage): the first in the tab it opened with (best effort) */
async function restoreTabs(client: HolderClient, tabs: readonly ChatBrowserTab[]): Promise<void> {
  // Gone (closed or crashed): nothing more to open. Told by its exit, not its error's text (the
  // holder's last stderr line, which can say anything)
  let gone = false;
  client.exited.catch(() => {
    gone = true;
  });
  for (const [index, tab] of tabs.entries()) {
    if (gone) return;
    const call = index === 0
      ? { name: 'browser_navigate', arguments: { url: tab.url } }
      : { name: 'browser_tabs', arguments: { action: 'new', url: tab.url } };
    try {
      const failure = replyFailure(await client.request('tools/call', call, RESTORE_TAB_TIMEOUT_MS));
      if (failure !== undefined) appLog.info(`[BrowserDrawer] Could not open ${tab.url}: ${holderError(failure)}`);
    } catch (error) {
      if (gone) return;
      appLog.info(`[BrowserDrawer] Could not open ${tab.url}:`, error);
    }
  }
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

/** How long a record change waits before it is written (tabs change in bursts while pages load) */
const RECORD_WRITE_DELAY_MS = 1000;

/** Keeps a chat browser's record file current (debounced writes; the last one before close wins) */
function recordWriter(dir: string, initial: ChatBrowserRecord) {
  let record = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const write = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (closed) return Promise.resolve();
    return writeFile(path.join(dir, CHAT_BROWSER_RECORD), JSON.stringify(record), { mode: 0o600 }).catch(() => undefined);
  };
  return {
    writeNow: write,
    current: () => record,
    update: (patch: Partial<Pick<ChatBrowserRecord, 'chatId' | 'tabs'>>) => {
      const next = { ...record, ...patch };
      if (JSON.stringify({ ...next, updatedAt: 0 }) === JSON.stringify({ ...record, updatedAt: 0 })) return;
      record = { ...next, updatedAt: Date.now() };
      if (!timer && !closed) timer = setTimeout(() => void write(), RECORD_WRITE_DELAY_MS);
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
    },
  };
}

/** How long listing or switching a Chromium browser's extensions may take */
const EXTENSIONS_TIMEOUT_MS = 30_000;

/** A Chromium chat browser's extensions, after switching the ones `switches` names (its extensions page, run by the holder) */
async function runChromiumExtensions(client: HolderClient, switches: ExtensionSwitches): Promise<BrowserExtension[]> {
  const reply = await client.request(
    'tools/call',
    { name: 'browser_run_code_unsafe', arguments: { code: chromiumExtensionsCode(switches) } },
    EXTENSIONS_TIMEOUT_MS,
  );
  const failure = replyFailure(reply);
  if (failure !== undefined) throw new Error(holderError(failure));
  return parseChromiumExtensions(reply.result?.content?.map((part) => part.text ?? '').join('\n') ?? '');
}

/**
 * A Firefox chat browser's extensions: as it runs them, each shown as its switch is (Settings),
 * which waits for the browser to start again when it differs
 */
async function firefoxExtensions(browserId: string, profileDir: string): Promise<BrowserExtensions> {
  const running = await readFirefoxExtensions(profileDir);
  const settings = (await readSettingsFileAsync()) as Partial<AppSettings> | undefined;
  const wanted = settings?.browser?.extensionSwitches?.[browserId] ?? {};
  let restartToApply = false;
  const list = running.map((extension) => {
    const on = wanted[extension.id];
    if (on === undefined || on === extension.enabled) return extension;
    restartToApply = true;
    return { ...extension, enabled: on };
  });
  return { browserId, extensions: list, canOpen: true, ...(restartToApply ? { restartToApply } : {}) };
}

/**
 * Start a holder for a chat: copy the chosen profile, start the server, open the browser. With a
 * browser left by a crash (`restore`) for the same browser, its folder and profile copy are used
 * again and its tabs reopened; for another browser it is removed and the chat's browser starts anew
 */
const startPlaywrightHolder: StartChatBrowserHolder = async ({ projectPath, title, choice, projectId, chatId, restore }) => {
  const startedAt = Date.now();
  const appSettings = (await readSettingsFileAsync()) as Partial<AppSettings> | undefined;
  const settings = appSettings?.mcpConnectors;
  const runSettings = chatRunSettings(settings, choice);
  // On Windows while the shell is WSL: the Windows profile of the choice (made from WSL's list)
  const node = windowsNode();
  if (node) runSettings.playwrightBrowser = await windowsBrowserChoice(runSettings.playwrightBrowser);
  const browser = runSettings.playwrightBrowser;
  const browserId = browser?.id ?? null;
  const reuse = restore && restore.record.browserId === browserId ? restore : undefined;
  if (restore && !reuse) await discardRestorable(restore);

  const cleanups: Array<() => Promise<void> | void> = [];
  const cleanup = async () => {
    for (const fn of cleanups.splice(0).reverse()) await Promise.resolve(fn()).catch(() => undefined);
  };
  // What is removed when the browser closes: at once for a new one; for a reused one only once it
  // started (a failed start leaves it to open again)
  const removals: Array<() => Promise<void> | void> = [];
  // Suspended for a restart: its folder and profile copy stay for the next start
  let suspended = false;
  const unlessSuspended = (fn: () => Promise<void>) => () => (suspended ? undefined : fn());
  // Chat browsers run the profile's extensions (Settings > Browser), switched as the drawer left them
  const extensions = chatBrowserExtensions(appSettings);
  const switches: ExtensionSwitches = (extensions && browser && appSettings?.browser?.extensionSwitches?.[browser.id]) || {};
  try {
    // The holder's own folder: its workspace and output folder, registered for the project
    // Where the browser runs (in WSL inside the distribution: a profile on /mnt/c is slow for it)
    const dir = reuse ? reuse.dir : await makeTempFolder(TEMP_FOLDER_PREFIXES.chatBrowser, await runtimeTempParent());
    removals.push(unlessSuspended(() => removeTempFolder(dir)));
    for (const folder of new Set([dir, await realpath(dir).catch(() => dir)])) {
      cleanups.push(registerChatBrowserWorkspace(folder, projectPath));
    }

    let browserProfileDir: string | undefined;
    // The crashed browser's copy stays kept (never swept, left on quit) until this start worked, so
    // a failed start leaves it, sign-ins and all, to open again
    let keptCopy: string | undefined;
    if (browser && !browser.managed) {
      if (reuse?.record.profileCopyDir) {
        const copy = reuse.record.profileCopyDir;
        browserProfileDir = keptCopy = copy;
        removals.push(unlessSuspended(() => removeBrowserProfileCopy(copy)));
        // The switch as it is now, not as it was when the crashed browser started
        await setBrowserProfileCopyExtensions(browser, copy, extensions).catch((error) => {
          appLog.warn('[BrowserDrawer] Could not set the extensions of a kept browser profile copy:', error);
        });
      } else {
        const inUse = await browserChoicesInUse(projectPath, settings?.playwrightBrowser).catch(() => undefined);
        browserProfileDir = (await prepareBrowserProfileCopy(projectPath, browser, `chat-${randomUUID().slice(0, 8)}`, inUse, { extensions }).catch((error) => {
          appLog.warn('[BrowserDrawer] Could not copy the browser profile for a chat:', error);
          return null;
        })) ?? undefined;
        // A copy made now goes with a failed start too (the next try makes another)
        if (browserProfileDir) {
          const copy = browserProfileDir;
          cleanups.push(unlessSuspended(() => removeBrowserProfileCopy(copy)));
        }
      }
      // Firefox reads its extensions' switches at start
      if (browserProfileDir && extensions && browser.engine === 'firefox') {
        await applyFirefoxExtensionSwitches(browserProfileDir, switches).catch((error) => {
          appLog.warn('[BrowserDrawer] Could not switch the extensions of a browser profile copy:', error);
        });
      }
    }
    if (!reuse) cleanups.push(...removals.splice(0));
    const copiedAt = Date.now();

    // Its record, for a restart after a crash (a close or quit removes it with the folder)
    const record = recordWriter(dir, {
      projectId: projectId ?? reuse?.record.projectId ?? '',
      projectPath,
      chatId: chatId ?? reuse?.record.chatId ?? '',
      browserId,
      profileCopyDir: browserProfileDir ?? null,
      tabs: reuse?.record.tabs ?? [],
      updatedAt: Date.now(),
    });
    void record.writeNow();
    cleanups.push(() => record.close());

    const entry = buildMcpConfig(['playwright'], runSettings, { browserProfileDir }).mcpServers.playwright;
    if (entry?.type !== 'stdio') throw new Error('Playwright is not available');
    // Windows' Node.js while chat browsers run there (the shell's lookups are WSL's)
    const command = node ? node.npx : await resolveCommand(entry.command);
    if (!command) throw new Error(`${entry.command} was not found`);
    const baseEnv = node ? withWindowsNodeOnPath(process.env, node) : getWslInfo() ? process.env : await getToolEnvAsync();
    const proc = spawnTool('python', holderArgs(entry.args ?? [], dir), {
      command,
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // In WSL the distribution's login environment applies (only changed variables are passed in)
      env: { ...baseEnv, ...entry.env },
      windowsHide: true,
      // Its own process group, so the server npx starts (and its browser) can be stopped with it
      detached: !isWindows(),
    });
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    const client = holderClient(proc);
    try {
      await initializeHolder(client, title);
    } catch (error) {
      await closeHolderProcess(proc);
      throw error;
    }
    // How long a start takes where (Windows and WSL starts differ a lot)
    appLog.info(
      `[BrowserDrawer] Chat browser started in ${Date.now() - startedAt} ms (profile copy ${copiedAt - startedAt} ms, `
      + `server and browser ${Date.now() - copiedAt} ms; ${node ? 'on Windows' : getWslInfo() ? 'in WSL' : 'natively'}, ${browser?.id ?? 'chromium'})`
    );
    // Started: a reused folder and copy go when it closes (or on quit), like a new one's
    if (keptCopy) useKeptBrowserProfileCopy(keptCopy);
    cleanups.push(...removals.splice(0));
    // Chromium switches its extensions while it runs: before any page opens
    const hasExtensions = !!browserProfileDir && extensions && (browser?.engine === 'chromium' || browser?.engine === 'firefox');
    if (hasExtensions && browser?.engine === 'chromium' && Object.keys(switches).length > 0) {
      await runChromiumExtensions(client, switches).catch((error) => {
        appLog.warn('[BrowserDrawer] Could not switch the extensions of a chat browser:', error);
      });
    }
    const tabs = reuse ? tabsToRestore(reuse.record.tabs) : [];
    if (tabs.length > 0) void restoreTabs(client, tabs);
    else {
      // A new browser opens on the homepage (Settings > Browser); one that doesn't load leaves it blank
      const homepage = homepageUrl(appSettings?.browser?.homepage);
      if (homepage) void restoreTabs(client, [{ url: homepage, title: '' }]);
    }

    const listeners: Array<() => void> = [];
    // Gone (closed, crashed or stopped): its folder, profile copy and registration go too
    const done = exited.then(async () => {
      await cleanup();
      // Its closed browser's entry in Playwright's registry (kept there because it had a profile folder)
      const registry = registryAccess(registryOs());
      await removeClosedSessions(registry.dir, title, registry.connect);
      // Out of a native start's scope (runNatively): what the listeners set off is the app's
      for (const listener of listeners) runInSessionRuntime(listener);
    });
    return {
      browser: browser ?? null,
      close: async () => {
        await closeHolderProcess(proc);
        await done;
      },
      onExit: (listener) => {
        listeners.push(listener);
      },
      updateRecord: (patch) => record.update(patch),
      extensions: async (changes) => {
        if (!hasExtensions || !browser || !browserProfileDir) return null;
        if (browser.engine === 'chromium') {
          return { browserId: browser.id, extensions: await runChromiumExtensions(client, changes ?? {}), canOpen: true };
        }
        return firefoxExtensions(browser.id, browserProfileDir);
      },
      extensionTarget: async (extensionId) =>
        hasExtensions && browser?.engine === 'firefox' && browserProfileDir ? firefoxExtensionTarget(browserProfileDir, extensionId) : {},
      suspend: async () => {
        suspended = true;
        await record.writeNow();
        const kept = { dir, record: record.current() };
        await closeHolderProcess(proc);
        await done;
        return kept;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

/**
 * Start a holder where chat browsers run: on Windows (natively throughout, runNatively) when
 * Settings > Browser runs them there while the shell is WSL, else where the shell runs tools
 */
const startChatBrowserHolder: StartChatBrowserHolder = async (options) => {
  await whenChatBrowserRuntimeReady();
  return inChatBrowserRuntime(() => startPlaywrightHolder(options));
};
