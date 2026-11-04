/**
 * The browser drawer
 * ==================
 *
 * Playwright runs (task runs, Claude chats) launch their browsers headless; the user sees and
 * drives Claude chats' browsers in the main window's browser drawer, Workbench's own UI. Task runs'
 * browsers stay headless and unseen: no project is matched for them, so no window shows them and
 * the bridge never connects to them. This service:
 * - watches Playwright's registry (registry.ts) every few seconds and tells every window the
 *   live sessions, each chat's with the project it belongs to (project-match.ts), so a window can
 *   show that its project has browsers and open the drawer when one starts
 * - once a drawer opens, runs the browser bridge (bridge-process.ts, until quit), which connects to the
 *   projects' browsers and reports their pages, streams the page a window views as JPEG frames
 *   (sent to that window only), sizes it to the window's drawer, replays the window's input and
 *   opens new tabs
 * - opens and closes the chats' own browsers (chat-browsers.ts), which it tells by their title
 *
 * In WSL mode the browsers run inside the distribution, where their registry and sockets are: the
 * registry is read through `\\wsl.localhost`, the bridge runs there (with the distribution's
 * node) and also says which registered browsers answer, and workspace folders are matched to
 * projects as Windows paths (toHostPath).
 */

import type { WebContents } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  BrowserDrawerInput,
  BrowserDrawerNavigation,
  BrowserDrawerPage,
  BrowserDrawerSession,
  BrowserDrawerState,
} from '../../shared/types/browser-drawer';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import { appLog } from '../app-logger';
import { isMacOS, isWindows } from '../platform';
import { getWslInfo, toHostPath, whenShellRuntimeReady } from '../platform/shell-runtime';
import path from 'path';
import { getAllWindows } from '../window-manager';
import { readLiveSessions, registryAccess, registryOs, setRegistryAccess, type RegistryDescriptor } from './registry';
import { getChatBrowserWorkspaces, sessionProjectId, type ProjectLocation } from './project-match';
import { BrowserBridgeProcess, type BridgeMessage, type BridgeSession } from './bridge-process';
import { ChatBrowsers } from './chat-browsers';

/** How often the registry is read */
const POLL_INTERVAL_MS = 2000;
/** The largest viewport the drawer may give a page */
const MAX_VIEWPORT = 4096;

/** The sessions as the renderer gets them, each with its project (and chat, for a chat's browser) */
export function toDrawerSessions(
  descriptors: readonly RegistryDescriptor[],
  projects: readonly ProjectLocation[],
  chats: ReadonlyMap<string, string>,
  caseInsensitive: boolean,
  chatOfTitle: (title: string) => { projectId: string; chatId: string; browser?: PlaywrightBrowserChoice | null } | undefined = () => undefined,
  /** A workspace folder as the app stores paths (WSL mode: the distribution's Linux paths as Windows ones) */
  hostPath: (dir: string) => string = (dir) => dir,
): BrowserDrawerSession[] {
  return descriptors.map((descriptor) => {
    const workspaceDir = descriptor.workspaceDir ? hostPath(descriptor.workspaceDir) : undefined;
    const projectId = sessionProjectId(workspaceDir, projects, chats, caseInsensitive);
    const chat = projectId ? chatOfTitle(descriptor.title) : undefined;
    // A chat's browser shows the browser the chat chose: the registry can't tell, since a profile's
    // browser may run on Playwright's own build (a Windows Firefox profile in WSL) or be attached
    // over CDP with no executable recorded (a Windows Chromium browser in WSL)
    const chosen = chat && chat.projectId === projectId ? chat.browser : undefined;
    return {
      id: descriptor.guid,
      title: descriptor.title,
      browserName: chosen === undefined ? descriptor.browserName : chosen?.engine ?? 'chromium',
      managed: chosen === undefined ? descriptor.managed : chosen === null || !!chosen.managed,
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(projectId ? { projectId } : {}),
      ...(chat && chat.projectId === projectId ? { chatId: chat.chatId } : {}),
    };
  });
}

/** The sessions the bridge connects to: the projects' ones (never another tool's browsers) */
export function bridgeSessions(descriptors: readonly RegistryDescriptor[], sessions: readonly BrowserDrawerSession[]): BridgeSession[] {
  const withProject = new Set(sessions.filter((s) => s.projectId).map((s) => s.id));
  return descriptors
    .filter((d): d is RegistryDescriptor & { endpoint: string; playwrightLib: string } =>
      withProject.has(d.guid) && !!d.endpoint && !!d.playwrightLib)
    .map((d) => ({ id: d.guid, endpoint: d.endpoint, browserName: d.browserName, playwrightLib: d.playwrightLib }));
}

/** Frames are asked at most at this many device pixels per CSS pixel (4x the pixels at 1, like a Retina screen) */
const MAX_FRAME_SCALE = 2;

/** A viewport size the drawer may ask for (whole CSS pixels within limits), or 0 for none */
export function viewportDimension(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  return n > 0 ? Math.min(n, MAX_VIEWPORT) : 0;
}

/** Device pixels per CSS pixel the drawer's frames are asked at: the window's devicePixelRatio, 1 to 2 */
export function frameScale(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.round(Math.min(Math.max(n, 1), MAX_FRAME_SCALE) * 100) / 100;
}

/** Whether a renderer's input event has the shape the bridge replays */
export function isDrawerInput(event: unknown): event is BrowserDrawerInput {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  switch (e.kind) {
    case 'mousemove':
      return num(e.x) && num(e.y);
    case 'mousedown':
    case 'mouseup':
      return num(e.x) && num(e.y) && ['left', 'right', 'middle'].includes(e.button as string) && num(e.clickCount);
    case 'wheel':
      return num(e.x) && num(e.y) && num(e.deltaX) && num(e.deltaY);
    case 'keydown':
    case 'keyup':
      return typeof e.key === 'string' && e.key.length > 0 && e.key.length <= 32;
    case 'text':
      return typeof e.text === 'string' && e.text.length <= 100_000;
    default:
      return false;
  }
}

export interface BrowserDrawerServiceOptions {
  getProjects: () => readonly ProjectLocation[];
  registryDir?: string;
  bridge?: BrowserBridgeProcess;
  chatBrowsers?: ChatBrowsers;
}

export class BrowserDrawerService {
  private descriptors: RegistryDescriptor[] = [];
  private sessions: BrowserDrawerSession[] = [];
  private pages: BrowserDrawerPage[] = [];
  /** The sessions the bridge is connected to */
  private connectedSessions: string[] = [];
  private readonly dead = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight: Promise<void> | null = null;
  private stopped = false;
  private readonly bridge: BrowserBridgeProcess;
  /** Windows whose drawer is open */
  private readonly subscribers = new Map<number, WebContents>();
  /**
   * The page each window last asked to view. A reopened drawer's page asks before the drawer has
   * subscribed (child effects run first), so the request is kept and sent once it subscribes
   */
  private readonly views = new Map<number, { pageId: string | null; width: unknown; height: unknown; scale: unknown }>();
  private lastBridgeSessions = '';
  /** Workbench's theme, which the chat browsers' pages get as their color scheme (null: not told yet) */
  private colorScheme: 'light' | 'dark' | null = null;
  readonly chatBrowsers: ChatBrowsers;

  constructor(private readonly options: BrowserDrawerServiceOptions) {
    this.bridge = options.bridge ?? new BrowserBridgeProcess();
    this.chatBrowsers = options.chatBrowsers ?? new ChatBrowsers();
    this.bridge.on('message', (message: BridgeMessage) => this.onBridgeMessage(message));
    this.bridge.on('exit', () => {
      this.lastBridgeSessions = '';
      if (this.pages.length || this.connectedSessions.length) {
        this.pages = [];
        this.connectedSessions = [];
        this.broadcast();
      }
    });
    // A chat browser that opened shows up in the registry: read it now rather than in a while
    this.chatBrowsers.on('change', () => {
      this.broadcast();
      if (this.timer) void this.poll();
    });
  }

  /**
   * Start watching the registry. In WSL mode the browsers run inside the distribution: its
   * registry is read through `\\wsl.localhost`, and whether a browser runs is asked of the bridge,
   * which runs there too (Windows can't reach the browsers' Unix sockets)
   */
  async start(): Promise<void> {
    await whenShellRuntimeReady();
    if (this.stopped) return;
    const wsl = getWslInfo();
    if (wsl && !this.options.registryDir) {
      setRegistryAccess({
        dir: toHostPath(path.posix.join(wsl.home, '.cache', 'ms-playwright', 'b')),
        connect: (endpoint) => this.bridge.probe([endpoint]).then((live) => (live ? live.has(endpoint) : null)),
      });
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  getState(): BrowserDrawerState {
    return {
      available: true,
      sessions: this.sessions,
      pages: this.pages,
      connectedSessions: this.connectedSessions,
      chatBrowsers: this.chatBrowsers.list(),
    };
  }

  /** A window's drawer opened: the bridge runs and tracks the projects' pages */
  async subscribe(sender: WebContents): Promise<void> {
    if (this.stopped) return;
    if (!this.subscribers.has(sender.id)) {
      const id = sender.id;
      this.subscribers.set(id, sender);
      sender.once('destroyed', () => {
        this.unsubscribe(id);
        this.views.delete(id);
      });
    }
    await this.bridge.start();
    this.syncBridgeSessions(true);
    // The view asked for before subscribing (unless the drawer closed again meanwhile)
    const pending = this.views.get(sender.id);
    if (pending && this.subscribers.has(sender.id) && !sender.isDestroyed()) {
      this.view(sender, pending.pageId, pending.width, pending.height, pending.scale);
    }
  }

  /** Workbench's theme changed (or a drawer opened): the chat browsers' pages follow it */
  setColorScheme(scheme: unknown): void {
    if (scheme !== 'light' && scheme !== 'dark') return;
    if (scheme === this.colorScheme) return;
    this.colorScheme = scheme;
    if (this.bridge.running) this.bridge.send({ type: 'colorScheme', scheme });
  }

  /** A window's drawer closed: its page is no longer streamed */
  unsubscribe(viewerId: number): void {
    this.views.delete(viewerId);
    if (!this.subscribers.delete(viewerId)) return;
    this.bridge.send({ type: 'view', viewerId, pageId: null, width: 0, height: 0 });
  }

  view(sender: WebContents, pageId: string | null, width: unknown, height: unknown, scale?: unknown): void {
    if (this.stopped) return;
    this.views.set(sender.id, { pageId, width, height, scale });
    if (!this.subscribers.has(sender.id)) return;
    const known = pageId !== null && this.pages.some((page) => page.id === pageId);
    this.bridge.send({
      type: 'view',
      viewerId: sender.id,
      pageId: known ? pageId : null,
      width: viewportDimension(width),
      height: viewportDimension(height),
      scale: frameScale(scale),
    });
  }

  input(pageId: string, event: unknown): void {
    if (!this.pages.some((page) => page.id === pageId) || !isDrawerInput(event)) return;
    this.bridge.send({ type: 'input', pageId, event });
  }

  navigate(pageId: string, action: BrowserDrawerNavigation, url?: string): void {
    if (!this.pages.some((page) => page.id === pageId)) return;
    if (action === 'goto') {
      if (typeof url !== 'string' || !/^(https?|about|file):/i.test(url)) return;
      this.bridge.send({ type: 'navigate', pageId, action, url });
    } else if (action === 'back' || action === 'forward' || action === 'reload') {
      this.bridge.send({ type: 'navigate', pageId, action });
    }
  }

  closePage(pageId: string): void {
    if (this.pages.some((page) => page.id === pageId)) this.bridge.send({ type: 'closePage', pageId });
  }

  /** Open a new tab in a session's browser */
  newPage(sessionId: string): void {
    if (this.sessions.some((session) => session.id === sessionId && session.projectId)) this.bridge.send({ type: 'newPage', sessionId });
  }

  /** Open a chat's own browser (the drawer's Open browser button, or a turn's first browser tool call) */
  async openChatBrowser(projectId: string, chatId: string, choice: PlaywrightBrowserChoice | null | undefined): Promise<void> {
    const project = this.options.getProjects().find((p) => p.id === projectId);
    if (!project) throw new Error('The project is not open');
    await this.chatBrowsers.ensure(projectId, project.path, chatId, choice);
  }

  closeChatBrowser(projectId: string, chatId: string): Promise<void> {
    return this.chatBrowsers.close(projectId, chatId);
  }

  /** Stop watching and stop the bridge (the app is quitting; the browsers stop with their runs) */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([this.bridge.stop(), this.chatBrowsers.shutdown()]);
  }

  /** Stop the bridge at once (the app is exiting) */
  killNow(): void {
    this.bridge.killNow();
  }

  private onBridgeMessage(message: BridgeMessage): void {
    if (message.type === 'pages') {
      this.pages = message.pages;
      this.connectedSessions = message.connected ?? [];
      this.noteChatTabs();
      this.broadcast();
    } else if (message.type === 'frame') {
      for (const viewerId of message.viewers) {
        const target = this.subscribers.get(viewerId);
        if (target && !target.isDestroyed()) {
          target.send(IPC_CHANNELS.BROWSER_DRAWER_FRAME, {
            pageId: message.pageId,
            data: message.data,
            width: message.width,
            height: message.height,
          });
        }
      }
    } else if (message.type === 'log') {
      appLog.warn(`[BrowserDrawer] ${message.message}`);
    }
  }

  /** The chats' browsers' open tabs, kept in their records for a restart after a crash */
  private noteChatTabs(): void {
    const connected = new Set(this.connectedSessions);
    for (const session of this.sessions) {
      if (!session.chatId || !session.projectId || !connected.has(session.id)) continue;
      const tabs = this.pages
        .filter((page) => page.sessionId === session.id)
        .map((page) => ({ url: page.url, title: page.title }));
      this.chatBrowsers.noteTabs(session.projectId, session.chatId, tabs);
    }
  }

  /** Tell the bridge the projects' live sessions (when they changed, or `force`) */
  private syncBridgeSessions(force = false): void {
    if (!this.bridge.running) return;
    const sessions = bridgeSessions(this.descriptors, this.sessions);
    const key = JSON.stringify(sessions);
    if (!force && key === this.lastBridgeSessions) return;
    // A bridge that just started (a drawer opened, or in WSL a liveness probe started it again
    // after it stopped) knows no theme yet: sent before the sessions, so pages get it as they are found
    if (this.lastBridgeSessions === '' && this.colorScheme) this.bridge.send({ type: 'colorScheme', scheme: this.colorScheme });
    this.lastBridgeSessions = key;
    this.bridge.send({ type: 'sessions', sessions });
  }

  /** Read the registry (once at a time: a call during a read waits for it) */
  private poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pollInFlight ??= this.readRegistry().finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  private async readRegistry(): Promise<void> {
    try {
      // The bridge's browsers aren't asked: its link reports when one goes away
      const connected = new Set(this.connectedSessions);
      const registry = this.options.registryDir
        ? { dir: this.options.registryDir, connect: undefined }
        : registryAccess(registryOs());
      this.descriptors = await readLiveSessions(registry.dir, this.dead, registry.connect, (guid) => connected.has(guid));
      this.chatBrowsers.syncLive(new Set(this.descriptors.map((descriptor) => descriptor.title)));
      const sessions = toDrawerSessions(
        this.descriptors,
        this.options.getProjects(),
        getChatBrowserWorkspaces(),
        isWindows() || isMacOS(),
        (title) => this.chatBrowsers.chatOfTitle(title),
        // WSL mode: the distribution's folders, as the app stores them (Windows paths)
        getWslInfo() ? toHostPath : undefined,
      );
      if (JSON.stringify(sessions) !== JSON.stringify(this.sessions)) {
        this.sessions = sessions;
        this.broadcast();
      }
      this.syncBridgeSessions();
    } catch (error) {
      appLog.warn('[BrowserDrawer] Could not read Playwright\'s registry:', error);
    }
  }

  private broadcast(): void {
    const state = this.getState();
    for (const window of getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.BROWSER_DRAWER_STATE, state);
    }
  }
}
