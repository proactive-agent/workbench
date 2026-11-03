/**
 * The browser bridge process
 * ==========================
 *
 * browser-bridge.cjs, started where the browsers run: natively with Workbench's executable as
 * Node (ELECTRON_RUN_AS_NODE), in WSL mode with the distribution's node (spawnTool), since the
 * browsers, their registry and their Unix sockets are inside the distribution. Messages go over
 * its stdin/stdout as JSON headers with bytes (bridge-framing.ts), so JPEG frames arrive as
 * bytes. It loads each browser's own playwright-core from the session's registry descriptor:
 * nothing of Playwright ships with the app, and the client always matches the server that
 * launched the browser. It runs apart from the main process so Playwright's client and the frames
 * never weigh on it; it exits when its stdin closes, so it never outlives Workbench.
 */

import type { ChildProcess } from 'child_process';
import { writeFile } from 'fs/promises';
import { makeTempFolder, removeTempFolder, TEMP_FOLDER_PREFIXES } from '../temp-folders';
import path from 'path';
import { EventEmitter } from 'events';
import { appLog } from '../app-logger';
import { getWslInfo, whenShellRuntimeReady } from '../platform/shell-runtime';
import { killRuntimeProcess, spawnTool } from '../platform/runtime-exec';
import { resolveCommand } from '../mcp-commands';
import type { BrowserDrawerInput, BrowserDrawerNavigation, BrowserDrawerPage } from '../../shared/types/browser-drawer';
import { createBridgeMessageReader, encodeBridgeMessage } from './bridge-framing';
import BRIDGE_SOURCE from './browser-bridge.cjs?raw';

/** A browser the bridge connects to (from its registry descriptor) */
export interface BridgeSession {
  id: string;
  endpoint: string;
  browserName: string;
  playwrightLib: string;
}

export type BridgeRequest =
  | { type: 'sessions'; sessions: BridgeSession[] }
  | { type: 'view'; viewerId: number; pageId: string | null; width: number; height: number; scale?: number }
  | { type: 'input'; pageId: string; event: BrowserDrawerInput }
  | { type: 'navigate'; pageId: string; action: BrowserDrawerNavigation; url?: string }
  | { type: 'closePage'; pageId: string }
  | { type: 'newPage'; sessionId: string }
  | { type: 'probe'; id: number; endpoints: string[] };

export type BridgeMessage =
  | { type: 'pages'; pages: BrowserDrawerPage[]; connected?: string[] }
  | { type: 'frame'; pageId: string; viewers: number[]; data: Uint8Array; width: number; height: number }
  | { type: 'log'; message: string }
  | { type: 'probed'; id: number; live: string[] };

export interface BridgeProcessOptions {
  /** The bridge script (written to a temporary folder when not given) */
  scriptPath?: string;
  /** The executable that runs it as Node natively (Workbench's own) */
  execPath?: string;
}

/** How long a liveness probe may take (each endpoint is given a second) */
const PROBE_TIMEOUT_MS = 10_000;

/** Emits 'message' (BridgeMessage) and 'exit' */
export class BrowserBridgeProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private tempDir: string | null = null;
  private nextProbeId = 1;
  private readonly probes = new Map<number, (live: string[] | null) => void>();

  constructor(private readonly options: BridgeProcessOptions = {}) {
    super();
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Start the bridge (once) */
  start(): Promise<void> {
    if (this.child) return Promise.resolve();
    this.starting ??= this.spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Which of these endpoints answer, asked from where the browsers run (WSL mode: the main
   * process can't reach their sockets). Null when the bridge couldn't tell (not running, no answer)
   */
  async probe(endpoints: string[]): Promise<Set<string> | null> {
    await this.start().catch(() => undefined);
    if (!this.child) return null;
    const id = this.nextProbeId++;
    const live = await new Promise<string[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.probes.delete(id);
        resolve(null);
      }, PROBE_TIMEOUT_MS);
      this.probes.set(id, (result) => {
        clearTimeout(timer);
        this.probes.delete(id);
        resolve(result);
      });
      if (!this.write({ type: 'probe', id, endpoints })) this.probes.get(id)?.(null);
    });
    return live ? new Set(live) : null;
  }

  private async spawn(): Promise<void> {
    await whenShellRuntimeReady();
    let script = this.options.scriptPath;
    if (!script) {
      // On the Windows side in WSL mode too: the distribution's node reads it through /mnt
      this.tempDir = await makeTempFolder(TEMP_FOLDER_PREFIXES.browserBridge);
      script = path.join(this.tempDir, 'browser-bridge.cjs');
      await writeFile(script, BRIDGE_SOURCE, 'utf-8');
    }
    const wsl = getWslInfo();
    const command = wsl ? await resolveCommand('node') : this.options.execPath ?? process.execPath;
    if (!command) {
      void this.removeTempDir();
      throw new Error(`Node.js was not found in WSL (${wsl?.distro ?? 'unknown'}), which the browser drawer needs`);
    }
    const child = spawnTool('node', [script], {
      command,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(wsl ? {} : { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }),
      windowsHide: true,
    });
    this.child = child;
    const read = createBridgeMessageReader(
      (message) => this.onMessage(message as BridgeMessage),
      (skipped) => appLog.warn(`[BrowserDrawer] Skipped ${skipped} bytes from the bridge that weren't a message`),
    );
    child.stdout?.on('data', (data: Buffer) => read(data));
    child.stdin?.on('error', () => undefined);
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8').trim();
      if (text) appLog.warn(`[BrowserDrawer] Bridge: ${text}`);
    });
    // Gone: exited, or never started (no exit event follows a failed start)
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const settle of [...this.probes.values()]) settle(null);
      void this.removeTempDir();
      this.emit('exit');
    };
    child.on('error', (error) => {
      appLog.warn('[BrowserDrawer] Bridge error:', error);
      if (child.pid === undefined) gone();
    });
    child.on('exit', (code) => {
      if (code && this.child === child) appLog.warn(`[BrowserDrawer] The browser bridge stopped (code ${code})`);
      gone();
    });
  }

  private onMessage(message: BridgeMessage): void {
    if (message.type === 'probed') {
      this.probes.get(message.id)?.(Array.isArray(message.live) ? message.live : []);
      return;
    }
    this.emit('message', message);
  }

  send(request: BridgeRequest): void {
    this.write(request);
  }

  private write(request: BridgeRequest): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(encodeBridgeMessage(request as unknown as Record<string, unknown>));
      return true;
    } catch (error) {
      appLog.warn('[BrowserDrawer] Could not reach the bridge:', error);
      return false;
    }
  }

  /** Stop the bridge (it disconnects from the browsers, which keep running) */
  stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    for (const settle of [...this.probes.values()]) settle(null);
    if (!child || child.exitCode !== null) return this.removeTempDir();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killRuntimeProcess(child, { timeoutMs: 1000 });
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      // Its input ends: it disconnects and exits
      child.stdin?.end();
    }).then(() => this.removeTempDir());
  }

  /** Stop at once (the app is exiting) */
  killNow(): void {
    const child = this.child;
    this.child = null;
    child?.stdin?.destroy();
    child?.kill();
  }

  private async removeTempDir(): Promise<void> {
    const dir = this.tempDir;
    this.tempDir = null;
    if (dir) await removeTempFolder(dir);
  }
}
