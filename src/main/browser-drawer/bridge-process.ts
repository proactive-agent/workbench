/**
 * The browser bridge process
 * ==========================
 *
 * browser-bridge.cjs, forked with Workbench's executable as Node (ELECTRON_RUN_AS_NODE) and IPC
 * with advanced serialization, so JPEG frames arrive as bytes. It loads each browser's own
 * playwright-core from the session's registry descriptor: nothing of Playwright ships with the
 * app, and the client always matches the server that launched the browser. It runs apart from the
 * main process so Playwright's client and the frames never weigh on it; it exits when its IPC
 * channel closes, so it never outlives Workbench.
 */

import { fork, type ChildProcess } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { appLog } from '../app-logger';
import type { BrowserDrawerInput, BrowserDrawerNavigation, BrowserDrawerPage } from '../../shared/types/browser-drawer';
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
  | { type: 'view'; viewerId: number; pageId: string | null; width: number; height: number }
  | { type: 'input'; pageId: string; event: BrowserDrawerInput }
  | { type: 'navigate'; pageId: string; action: BrowserDrawerNavigation; url?: string }
  | { type: 'closePage'; pageId: string }
  | { type: 'newPage'; sessionId: string };

export type BridgeMessage =
  | { type: 'pages'; pages: BrowserDrawerPage[]; connected?: string[] }
  | { type: 'frame'; pageId: string; viewers: number[]; data: Uint8Array; width: number; height: number }
  | { type: 'log'; message: string };

export interface BridgeProcessOptions {
  /** The bridge script (written to a temporary folder when not given) */
  scriptPath?: string;
  /** The executable that runs it as Node (Workbench's own) */
  execPath?: string;
}

/** Emits 'message' (BridgeMessage) and 'exit' */
export class BrowserBridgeProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private tempDir: string | null = null;

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

  private async spawn(): Promise<void> {
    let script = this.options.scriptPath;
    if (!script) {
      this.tempDir = await mkdtemp(path.join(os.tmpdir(), 'workbench-browser-bridge-'));
      script = path.join(this.tempDir, 'browser-bridge.cjs');
      await writeFile(script, BRIDGE_SOURCE, 'utf-8');
    }
    const child = fork(script, [], {
      execPath: this.options.execPath ?? process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child = child;
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8').trim();
      if (text) appLog.warn(`[BrowserDrawer] Bridge: ${text}`);
    });
    child.on('message', (message: BridgeMessage) => this.emit('message', message));
    child.on('error', (error) => appLog.warn('[BrowserDrawer] Bridge error:', error));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (code) appLog.warn(`[BrowserDrawer] The browser bridge stopped (code ${code})`);
      void this.removeTempDir();
      this.emit('exit');
    });
  }

  send(request: BridgeRequest): void {
    const child = this.child;
    if (!child?.connected) return;
    try {
      child.send(request);
    } catch (error) {
      appLog.warn('[BrowserDrawer] Could not reach the bridge:', error);
    }
  }

  /** Stop the bridge (it disconnects from the browsers, which keep running) */
  stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return this.removeTempDir();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.disconnect();
    }).then(() => this.removeTempDir());
  }

  /** Stop at once (the app is exiting) */
  killNow(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
  }

  private async removeTempDir(): Promise<void> {
    const dir = this.tempDir;
    this.tempDir = null;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
