/**
 * Live agent relay: runs agent-flow's relay (./relay) in a worker thread while any project has
 * "Live agent" on (see live-agent-projects.ts), and passes its messages to the agent windows' graphs.
 *
 * The worker starts when a project switches it on (or at startup when one has it on) and keeps
 * running until the last project switches it off or the app quits. Agent windows only subscribe and
 * unsubscribe: opening or closing them never starts, stops or restarts it.
 */

import path from 'path';
import { BrowserWindow, type WebContents } from 'electron';
import type { Worker } from 'worker_threads';
import { IPC_CHANNELS } from '../../shared/constants';
import type { LiveAgentStatus } from '../../shared/types';
import { appLog } from '../app-logger';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { expandHomePath } from '../claude-profile/profile-utils';
import { getDefaultClaudeConfigDir } from '../claude-profile/config-dir-paths';
import { isWindows } from '../platform';
import { getWslInfo } from '../platform/shell-runtime';
import { createRelayWorker } from './create-relay-worker';
import { getTerminalWriteTime } from './terminal-activity';
import { windowOfSession } from '../agent-session-store';
import type { RelayWorkerMessage, RelayWorkerRequest } from './relay-worker-protocol';

/** How long the worker gets to clean up (discovery files, hook server, watchers) before it is terminated */
const STOP_TIMEOUT_MS = 2000;

/** Relay messages that name the window a session runs in (they all start with their type) */
const SESSION_MESSAGE_PREFIX = '{"type":"session-';

/** How recently an agent window must have been used for it to claim a session (ms) */
const RECENT_USE_MS = 2 * 60 * 1000;

/** Sessions whose window is remembered */
const MAX_REMEMBERED_SESSIONS = 200;

/** A directory as compared with another window's */
const dirKey = (dir: string) => (isWindows() ? path.resolve(dir).toLowerCase() : path.resolve(dir));

/** A graph in an agent window, shown sessions run in `cwd` (`flowDir`: its project's .workbench/flow) */
interface Subscription {
  webContents: WebContents;
  contentsId: number;
  clientId: string;
  /** The agent window the graph belongs to (its terminal id) */
  terminalId: string;
  cwd: string;
  flowDir: string;
}

/** What the relay tells a graph about a session (see relay/relay.ts) */
interface SessionInfoMessage {
  id?: string;
  owner?: string;
  [key: string]: unknown;
}

interface SessionMessage {
  type: string;
  sessionId?: string;
  owner?: string;
  session?: SessionInfoMessage;
  sessions?: SessionInfoMessage[];
  [key: string]: unknown;
}

/**
 * Claude Code config directories whose session transcripts are watched: the default one
 * (~/.claude) and each Claude profile's own (agent windows run with CLAUDE_CONFIG_DIR set to it)
 */
function getClaudeConfigDirs(): string[] {
  const dirs = [getDefaultClaudeConfigDir()];
  try {
    // Only the stored dirs: getSettings() checks each profile's credentials (keychain), which can block
    for (const configDir of getClaudeProfileManager().getProfileConfigDirs()) {
      dirs.push(path.resolve(expandHomePath(configDir)));
    }
  } catch (error) {
    appLog.warn('[LiveAgent] Could not read the Claude profiles:', error);
  }
  return [...new Set(dirs)];
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A relay message that names the window its sessions run in, or null for every other message */
function parseSessionMessage(data: string): SessionMessage | null {
  if (!data.startsWith(SESSION_MESSAGE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? (parsed as SessionMessage) : null;
  } catch {
    return null;
  }
}

export class LiveAgentRelay {
  private worker: Worker | null = null;
  /** A worker that was asked to stop and has not exited yet */
  private stopping: Promise<void> | null = null;
  private stoppingWorker: Worker | null = null;
  private enabled = false;
  /** The app is quitting: nothing starts again */
  private shutDown = false;
  private status: LiveAgentStatus = { state: 'stopped' };
  /** Graphs by key (`<webContents id>:<client id>`, the client id the worker knows) */
  private subscriptions = new Map<string, Subscription>();
  /** webContents whose destruction or reload drops their subscriptions */
  private trackedContents = new Set<number>();
  /** The agent window each session was given (see windowOf), newest last */
  private sessionWindows = new Map<string, string>();
  /** The window a session's hooks report, which Claude Code's shared daemon makes unreliable */
  private reportedWindows = new Map<string, string>();

  getStatus(): LiveAgentStatus {
    return this.status;
  }

  /** Follow the "Live agent" setting: start the relay (once) or stop it */
  setEnabled(enabled: boolean): void {
    // The settings dialog saves every setting on each change: only a real switch counts (a relay that
    // failed is retried by switching the setting off and on)
    if (this.shutDown || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this.start();
    else void this.stopWorker();
  }

  /** A graph in the agent window `terminalId` wants the sessions run in `cwd`, in the project
   *  whose flow dir is `flowDir` */
  subscribe(webContents: WebContents, clientId: string, cwd: string, flowDir: string, terminalId = ''): void {
    const contentsId = webContents.id;
    const key = `${contentsId}:${clientId}`;
    this.subscriptions.set(key, { webContents, contentsId, clientId, terminalId, cwd, flowDir });
    if (!this.trackedContents.has(contentsId)) {
      this.trackedContents.add(contentsId);
      const drop = () => {
        for (const [subscriptionKey, subscription] of this.subscriptions) {
          if (subscription.contentsId === contentsId) this.removeSubscription(subscriptionKey);
        }
      };
      webContents.once('destroyed', () => {
        this.trackedContents.delete(contentsId);
        drop();
      });
      // A reload unmounts the graphs without unsubscribing
      webContents.on('did-start-loading', drop);
    }
    this.post({ type: 'subscribe', clientId: key, cwd, flowDir, claudeDirs: getClaudeConfigDirs() });
  }

  unsubscribe(webContents: WebContents, clientId: string): void {
    this.removeSubscription(`${webContents.id}:${clientId}`);
  }

  /** A project switched Live agent off: its graphs no longer get anything (and the relay stops
   *  watching their directories) even before their windows unmount them */
  dropProject(flowDir: string): void {
    for (const [key, subscription] of this.subscriptions) {
      if (subscription.flowDir === flowDir) this.removeSubscription(key);
    }
  }

  /** Stop the relay for good (the app is quitting); resolves once the worker is gone */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    this.enabled = false;
    await this.stopWorker();
  }

  /** Last resort while the app quits: terminate any worker still running */
  terminateNow(): void {
    this.shutDown = true;
    this.enabled = false;
    for (const worker of [this.worker, this.stoppingWorker]) {
      if (worker) void worker.terminate().catch(() => undefined);
    }
    this.worker = null;
    this.stoppingWorker = null;
  }

  /** The message with every session's window decided here rather than taken from its hooks */
  private withWindows(message: SessionMessage, subscription: Subscription): string {
    const windowOf = (sessionId: string | undefined, reported: string | undefined) =>
      sessionId ? this.windowOf(sessionId, subscription.cwd, reported) : reported;
    const decided: SessionMessage = { ...message };
    switch (message.type) {
      case 'session-list':
        if (!message.sessions) break;
        decided.sessions = message.sessions.map((session) => ({ ...session, owner: windowOf(session.id, session.owner) }));
        break;
      case 'session-started':
        if (message.session) {
          decided.session = { ...message.session, owner: windowOf(message.session.id, message.session.owner) };
        }
        break;
      case 'session-owner':
        // The graphs take an empty owner as "any window's", as they do for a session with none
        decided.owner = windowOf(message.sessionId, message.owner) ?? '';
        break;
      default:
        return JSON.stringify(message);
    }
    return JSON.stringify(decided);
  }

  /**
   * The agent window a session belongs to.
   *
   * Claude Code runs its sessions in one daemon shared by the whole machine, which keeps the
   * environment of whichever window happened to start it: the terminal id a session's hooks
   * report is that window's, not the one the session runs in. So the reported window is only
   * taken while it is the single one watching the directory. With several, the session goes to
   * the window last used (the one the user ran it from), and otherwise, when none was used
   * recently, back to what its hooks report. The first answer for a session is kept while that
   * window is still there, so a session never moves from the graph already showing it.
   */
  private windowOf(sessionId: string, cwd: string, reported: string | undefined): string | undefined {
    if (reported) this.remember(this.reportedWindows, sessionId, reported);
    const key = dirKey(cwd);
    const candidates = [
      ...new Set(
        [...this.subscriptions.values()]
          .filter((subscription) => subscription.terminalId && dirKey(subscription.cwd) === key)
          .map((subscription) => subscription.terminalId)
      ),
    ];
    // The window Workbench started or resumed the session in knows it for sure (a window a chat
    // opened again was never typed into)
    const started = windowOfSession(sessionId);
    if (started && candidates.includes(started)) {
      this.remember(this.sessionWindows, sessionId, started);
      return started;
    }
    const decided = this.sessionWindows.get(sessionId);
    if (decided && candidates.includes(decided)) return decided;

    const claimed = reported ?? this.reportedWindows.get(sessionId);
    const fallback = claimed && candidates.includes(claimed) ? claimed : undefined;
    let window: string | undefined;
    if (candidates.length === 0) window = claimed;
    else if (candidates.length === 1) window = candidates[0];
    else {
      const lastUsed = candidates
        .map((terminalId) => ({ terminalId, at: getTerminalWriteTime(terminalId) }))
        .sort((a, b) => b.at - a.at)[0];
      window = Date.now() - lastUsed.at < RECENT_USE_MS ? lastUsed.terminalId : fallback;
    }
    if (window && candidates.includes(window)) this.remember(this.sessionWindows, sessionId, window);
    return window;
  }

  /** Keep a session's window, dropping the oldest once too many are remembered */
  private remember(windows: Map<string, string>, sessionId: string, terminalId: string): void {
    windows.delete(sessionId);
    windows.set(sessionId, terminalId);
    if (windows.size > MAX_REMEMBERED_SESSIONS) windows.delete(windows.keys().next().value!);
  }

  private removeSubscription(key: string): void {
    if (!this.subscriptions.delete(key)) return;
    this.post({ type: 'unsubscribe', clientId: key });
  }

  private post(request: RelayWorkerRequest): void {
    try {
      this.worker?.postMessage(request);
    } catch (error) {
      appLog.error('[LiveAgent] Could not reach the relay:', error);
    }
  }

  private start(): void {
    if (this.worker) return;
    this.setStatus({ state: 'starting' });
    // A worker still cleaning up first finishes (it removes the discovery files the new one writes)
    if (this.stopping) {
      void this.stopping.then(() => {
        if (this.enabled && !this.shutDown && !this.worker) this.start();
      });
      return;
    }

    let worker: Worker;
    try {
      // Claude Code inside WSL: the relay maps its Linux paths
      const wsl = getWslInfo();
      worker = createRelayWorker({ wsl: wsl ? { distro: wsl.distro, mountRoot: wsl.mountRoot } : null });
    } catch (error) {
      appLog.error('[LiveAgent] Could not start the relay:', error);
      this.setStatus({ state: 'error', error: errorMessage(error) });
      return;
    }
    this.worker = worker;
    worker.on('message', (message: RelayWorkerMessage) => this.onMessage(worker, message));
    worker.on('error', (error) => {
      if (this.worker !== worker) return;
      appLog.error('[LiveAgent] The relay failed:', error);
      this.worker = null;
      this.setStatus({ state: 'error', error: errorMessage(error) });
      void worker.terminate().catch(() => undefined);
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      appLog.error(`[LiveAgent] The relay stopped unexpectedly (exit code ${code})`);
      this.worker = null;
      this.setStatus({ state: 'error', error: `exit code ${code}` });
    });

    const claudeDirs = getClaudeConfigDirs();
    this.post({ type: 'start', claudeDirs });
    for (const [key, subscription] of this.subscriptions) {
      this.post({ type: 'subscribe', clientId: key, cwd: subscription.cwd, flowDir: subscription.flowDir, claudeDirs });
    }
  }

  private onMessage(worker: Worker, message: RelayWorkerMessage): void {
    if (this.worker !== worker) return;
    switch (message.type) {
      case 'ready':
        this.setStatus({ state: 'running' });
        break;
      case 'error':
        appLog.error('[LiveAgent] The relay could not start:', message.error);
        this.worker = null;
        this.setStatus({ state: 'error', error: message.error });
        void worker.terminate().catch(() => undefined);
        break;
      case 'message': {
        const sessionMessage = parseSessionMessage(message.data);
        for (const key of message.clientIds) {
          const subscription = this.subscriptions.get(key);
          if (!subscription || subscription.webContents.isDestroyed()) continue;
          const data = sessionMessage ? this.withWindows(sessionMessage, subscription) : message.data;
          subscription.webContents.send(IPC_CHANNELS.LIVE_AGENT_MESSAGE, subscription.clientId, data);
        }
        break;
      }
      case 'log':
        if (message.level === 'error') appLog.error(message.message);
        else if (message.level === 'warn') appLog.warn(message.message);
        else appLog.debug(message.message);
        break;
    }
  }

  /** Ask the worker to clean up and exit; terminated if it takes too long */
  private stopWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (this.status.state !== 'stopped') this.setStatus({ state: 'stopped' });
    if (!worker) return this.stopping ?? Promise.resolve();

    this.stoppingWorker = worker;
    const stopped = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', finish);
        worker.terminate().catch(() => undefined).then(() => resolve());
      };
      const onMessage = (message: RelayWorkerMessage) => {
        if (message?.type === 'stopped') finish();
      };
      const timer = setTimeout(finish, STOP_TIMEOUT_MS);
      worker.on('message', onMessage);
      worker.on('exit', finish);
      try {
        worker.postMessage({ type: 'stop' } satisfies RelayWorkerRequest);
      } catch {
        finish();
      }
    });
    const stopping: Promise<void> = stopped.then(() => {
      if (this.stoppingWorker === worker) this.stoppingWorker = null;
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  private setStatus(status: LiveAgentStatus): void {
    this.status = status;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.LIVE_AGENT_STATUS, status);
    }
  }
}

export const liveAgentRelay = new LiveAgentRelay();
