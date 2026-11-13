/**
 * Shell runtime: where Workbench runs its tools on Windows, chosen by the `windowsShell` setting
 * (Settings > General). 'pwsh' runs native Windows tools; 'wsl' runs everything inside WSL's
 * default distribution. The setting is read once at startup (a change applies after a restart).
 * When WSL is configured but can't be used, the session falls back to native and keeps the reason.
 *
 * Everything is native before `initShellRuntime()` finishes and on macOS/Linux. Not re-exported
 * from platform/index.ts.
 *
 * Code run through runNatively() sees a native runtime even in a WSL session: on Windows, chat
 * browsers can run natively while everything else runs in WSL (Settings > Browser, the
 * browser-drawer/browser-runtime.ts module), and their code paths are the native ones throughout.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type {
  ShellFallbackReason,
  ShellRuntimeStatus,
  WindowsShell,
  WslAvailability
} from '../../shared/types/settings';
import { appLog } from '../app-logger';
import { isWindows } from './index';
import { checkWslAvailable, probeWsl, type WslProbeResult } from './wsl-detect';
import { windowsToWsl, wslToWindows } from './wsl-paths';

export type { WindowsShell } from '../../shared/types/settings';

interface RuntimeState {
  configured: WindowsShell;
  active: WindowsShell;
  ready: boolean;
  wsl: WslAvailability | null;
  wslInfo: WslProbeResult | null;
  fallbackReason?: ShellFallbackReason;
  fallbackDetail?: string;
}

const nativeState = (): RuntimeState => ({
  configured: 'pwsh',
  active: 'pwsh',
  ready: false,
  wsl: null,
  wslInfo: null
});

let state: RuntimeState = nativeState();
let initPromise: Promise<ShellRuntimeStatus> | null = null;

/** The saved setting as a value: anything but 'wsl' (undefined included) means pwsh */
export function normalizeWindowsShell(value: unknown): WindowsShell {
  return value === 'wsl' ? 'wsl' : 'pwsh';
}

/** Status for Settings (and IPC): the value the app started with, the one it runs with, WSL availability */
export function getShellRuntimeStatus(): ShellRuntimeStatus {
  return {
    supported: isWindows(),
    ready: state.ready,
    configured: state.configured,
    active: state.active,
    wsl: state.wsl,
    ...(state.fallbackReason ? { fallbackReason: state.fallbackReason } : {}),
    ...(state.fallbackDetail ? { fallbackDetail: state.fallbackDetail } : {}),
    ...(state.active === 'wsl' && state.wslInfo ? { distro: state.wslInfo.distro } : {}),
    ...(autocrlfMismatch && state.active === 'wsl' ? { autocrlfMismatch } : {})
  };
}

let autocrlfMismatch: ShellRuntimeStatus['autocrlfMismatch'];

/** Record that Windows git and WSL git set core.autocrlf differently (null clears it); shown in the status */
export function setAutocrlfMismatch(mismatch: ShellRuntimeStatus['autocrlfMismatch'] | null): void {
  autocrlfMismatch = mismatch ?? undefined;
}

/**
 * Look up the tools inside WSL again (one probe), for tools installed after startup. Keeps the
 * session's runtime; the earlier probe stays when this one fails. Native: nothing to do.
 */
export async function reprobeWslTools(): Promise<ShellRuntimeStatus> {
  const info = getWslInfo();
  if (info) {
    try {
      const probe = await probeWsl(info.distro);
      // The runtime may have changed meanwhile (tests reset it)
      if (state.wslInfo === info) state.wslInfo = probe;
    } catch (error) {
      appLog.warn(`[ShellRuntime] Looking up the tools in WSL again failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return getShellRuntimeStatus();
}

function fallBackToNative(reason: ShellFallbackReason, detail?: string): void {
  state.active = 'pwsh';
  state.wslInfo = null;
  state.fallbackReason = reason;
  state.fallbackDetail = detail;
  appLog.warn(`[ShellRuntime] WSL is configured but can't be used (${reason}${detail ? `: ${detail}` : ''}); using native tools for this session`);
}

/**
 * Decide the runtime for this session from the saved `windowsShell` value. With 'wsl' on Windows
 * this checks WSL and probes its default distribution (async, may take a while on the first VM
 * boot); callers don't wait for it. Later calls return the first call's result.
 */
export function initShellRuntime(configuredValue?: unknown): Promise<ShellRuntimeStatus> {
  if (initPromise) return initPromise;

  const configured = normalizeWindowsShell(configuredValue);
  state = { ...nativeState(), configured };

  initPromise = (async () => {
    if (isWindows() && configured === 'wsl') {
      try {
        const availability = await checkWslAvailable();
        state.wsl = availability;
        if (!availability.available || !availability.defaultDistro) {
          fallBackToNative('wsl-unavailable', availability.reason);
        } else {
          state.wslInfo = await probeWsl(availability.defaultDistro);
          state.active = 'wsl';
          appLog.info(`[ShellRuntime] Running tools in WSL (${availability.defaultDistro})`);
        }
      } catch (error) {
        fallBackToNative('probe-failed', error instanceof Error ? error.message : String(error));
      }
    }
    state.ready = true;
    return getShellRuntimeStatus();
  })();

  return initPromise;
}

/** Resolves once startup detection finished (right away, with native status, before init) */
export function whenShellRuntimeReady(): Promise<ShellRuntimeStatus> {
  return initPromise ?? Promise.resolve(getShellRuntimeStatus());
}

/** Check WSL availability again (Settings); doesn't change the runtime of this session */
export async function refreshWslAvailability(): Promise<ShellRuntimeStatus> {
  if (isWindows()) {
    state.wsl = await checkWslAvailable({ refresh: true });
  }
  return getShellRuntimeStatus();
}

/** Set inside runNatively(): what runs there runs natively, whatever the session's runtime */
const nativeScope = new AsyncLocalStorage<true>();

/**
 * Run `fn` (and everything it starts, awaits or schedules) as if the session ran natively: the
 * runtime checks, path translations and spawnTool below act natively there. The session's own
 * runtime is unchanged for everything else
 */
export function runNatively<T>(fn: () => T): T {
  return nativeScope.run(true, fn);
}

/** Run `fn` in the session's own runtime, also from inside runNatively() (what it starts, too) */
export function runInSessionRuntime<T>(fn: () => T): T {
  return nativeScope.exit(fn);
}

/** Whether the session runs tools inside WSL, whatever runNatively() says (always false off Windows) */
function isWslSession(): boolean {
  return isWindows() && state.active === 'wsl' && state.wslInfo !== null;
}

/** The session's distribution when it runs in WSL, also inside runNatively() (else null) */
export function getSessionWslInfo(): WslProbeResult | null {
  return isWslSession() ? state.wslInfo : null;
}

/** Whether this session runs tools inside WSL (always false off Windows and inside runNatively()) */
export function isWslRuntime(): boolean {
  return isWslSession() && nativeScope.getStore() !== true;
}

/** The probed distribution when running in WSL, else null */
export function getWslInfo(): WslProbeResult | null {
  return isWslRuntime() ? state.wslInfo : null;
}

/**
 * Host (Windows) path -> the path the runtime's tools see. Identity when native; in WSL,
 * `C:\x` -> `/mnt/c/x` and `\\wsl.localhost\<distro>\x` -> `/x`. A path the distribution can't
 * reach (another distribution, a network share) is returned unchanged.
 */
export function toRuntimePath(hostPath: string): string {
  const info = getWslInfo();
  if (!info) return hostPath;
  return windowsToWsl(hostPath, { distro: info.distro, mountRoot: info.mountRoot }) ?? hostPath;
}

/** Runtime path -> host (Windows) path. Identity when native; in WSL, `/mnt/c/x` -> `C:\x`, `/x` -> `\\wsl.localhost\<distro>\x` */
export function toHostPath(runtimePath: string): string {
  const info = getWslInfo();
  if (!info) return runtimePath;
  return wslToWindows(runtimePath, { distro: info.distro, mountRoot: info.mountRoot });
}

/** Whether commands for the runtime use POSIX shell syntax (macOS, Linux, WSL) rather than Windows syntax */
export function runtimeUsesPosixShell(): boolean {
  return !isWindows() || isWslRuntime();
}

/** Back to the native state before init (tests) */
export function resetShellRuntimeForTests(): void {
  state = nativeState();
  initPromise = null;
  autocrlfMismatch = undefined;
}
