/**
 * MCP server availability
 * =======================
 *
 * Whether each connector's server can start where Claude Code runs. A stdio server is started
 * once, as a run would start it, until it answers the MCP `initialize` request: the first start
 * of an npx server downloads it (Puppeteer also downloads Chromium), so it is "preparing" until
 * then. A missing command or a server that fails, exits or doesn't answer makes it
 * "unavailable". Servers that need more than their own process (Puppeteer needs a browser) are
 * also asked to use it once. HTTP servers are reachable or not.
 *
 * Results are kept per connector and its connection details and sent to every window as they
 * change. Ready results stay for the app session; an unavailable one is checked again when asked
 * for after UNAVAILABLE_RECHECK_MS (it still reads unavailable until the new check ends), so a
 * fix the user ran shows up. resetMcpAvailability() forgets everything (tool paths changed).
 * A probe's server runs in its own process group and is stopped with everything it started. The Connectors page, the task dialog and the chat's MCP menu keep
 * a server's switch off and disabled until it is ready; runs leave out unavailable servers.
 *
 * Results are kept per connector but found per connection details and verifying call: connectors
 * with the same details (a custom server with the built-in Context7's command) share one probe, and
 * its result goes to each of them. A probe that also asks the server to do its work (Puppeteer
 * opening a browser) is never shared with one that only starts it.
 *
 * Puppeteer with a browser profile is also unavailable while that browser is open
 * (browser-profiles/in-use.ts): runs copy the profile, which an open browser keeps locked. Open
 * states are kept per browser. The chosen browser is the one in the settings the windows ask with
 * (read from the settings file each time); a run's settings may be older, so a run looks at its own
 * browser's lock without changing the chosen one. The chosen browser is looked at again when asked
 * for after BROWSER_RECHECK_MS, and every BROWSER_RECHECK_MS while it is open (whether or not
 * Puppeteer is on in the defaults: its switch is disabled while the browser is open, so the user
 * can only switch it on after closing it), so closing the browser enables the switch without a
 * page reload. A look is one read of the profile's lock.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { McpConnectorSettings } from '../shared/types/settings';
import type { McpAvailability } from '../shared/types/project';
import type { PuppeteerBrowserChoice } from '../shared/types/browser-profiles';
import { mcpServerEntry, type McpServerEntry } from './claude-code/mcp-config';
import { resetCommandLookups, resolveCommand } from './mcp-commands';
import { getToolEnvAsync } from './cli-utils';
import { isWindows } from './platform';
import { getWslInfo, whenShellRuntimeReady } from './platform/shell-runtime';
import { killRuntimeProcessTree, spawnTool } from './platform/runtime-exec';
import { browserProfileCopyBlocked } from './browser-profiles/profile-copy';
import { appLog } from './app-logger';

/** How long a server may take to answer: its first start downloads it */
const START_TIMEOUT_MS = 5 * 60 * 1000;
/** How long an HTTP server may take to answer */
const HTTP_TIMEOUT_MS = 10 * 1000;
/** How old an unavailable result may get before it is checked again */
export const UNAVAILABLE_RECHECK_MS = 30 * 1000;
/** How old the chosen browser's open state may get, and how often it is looked at while open */
const BROWSER_RECHECK_MS = 3 * 1000;

/** Display names of the built-in connectors, for log lines */
const BUILTIN_NAMES: Record<string, string> = { context7: 'Context7', electron: 'Electron', puppeteer: 'Puppeteer' };
const BROWSER_NAMES: Record<string, string> = {
  chrome: 'Chrome', edge: 'Edge', brave: 'Brave', chromium: 'Chromium', firefox: 'Firefox', safari: 'Safari',
};

/**
 * Puppeteer's error when its own browser isn't downloaded ("Could not find Chrome (ver. X)",
 * "Could not find Firefox"); other launch failures (no usable sandbox, missing libraries) aren't
 * fixed by a download
 */
const BROWSER_NOT_DOWNLOADED = /Could not find (Chrome|Firefox)\b(?: \(ver\. ([\d.]+)\))?/i;

/** The command that downloads Puppeteer's own browser, when a failed launch says it's missing */
function puppeteerInstallCommand(error: string): string | undefined {
  const match = BROWSER_NOT_DOWNLOADED.exec(error);
  if (!match) return undefined;
  const browser = match[1].toLowerCase();
  return `npx puppeteer browsers install ${browser}${match[2] ? `@${match[2]}` : ''}`;
}

/** A tool call that proves a server can do its work, not only start */
interface VerifyCall {
  name: string;
  arguments: Record<string, unknown>;
  /** The command that fixes a failed call, shown to the user (from the call's error), when there is one */
  fix?: (error: string) => string | undefined;
}

/**
 * Puppeteer's server starts without a browser and only needs one for its tools: it opens a blank
 * page in a hidden browser (closed when the server is stopped). That is the browser chosen in
 * Settings > Connectors (its executable comes with the server's entry, with Puppeteer's own
 * temporary profile, never the user's), otherwise Puppeteer's own Chrome
 */
function verifyCall(id: string, settings: McpConnectorSettings | undefined): VerifyCall | undefined {
  if (id !== 'puppeteer') return undefined;
  return {
    name: 'puppeteer_navigate',
    arguments: { url: 'about:blank', launchOptions: { headless: true } },
    // Puppeteer's own Chrome needs the exact build its error names ("Could not find Chrome (ver. X)");
    // a chosen browser is fixed by choosing another one
    ...(settings?.puppeteerBrowser ? {} : { fix: puppeteerInstallCommand }),
  };
}

const events = new EventEmitter();
/** Latest result per connector id and the entry it was found for */
const results = new Map<string, { key: string; availability: McpAvailability; checkedAt: number }>();
const probes = new Map<string, Promise<McpAvailability>>();
/** Servers being probed now */
const running = new Set<ChildProcess>();
/** Bumped by resetMcpAvailability: probes started before it don't report */
let generation = 0;
/** Whether each browser (by choice id) is open, and when that was seen */
const browserOpen = new Map<string, { open: boolean; checkedAt: number }>();
/** The looks at browsers' locks running now, by choice id */
const browserLooks = new Map<string, Promise<boolean>>();
/** Looks at the chosen browser again while it is open (for the choice id) */
let browserTimer: { id: string; timer: NodeJS.Timeout } | undefined;
/** The latest connector settings the windows asked with: the chosen browser now */
let puppeteerSettings: McpConnectorSettings | undefined;

/** The command that fixes an unavailable connector (its failed check's), when it has one */
export function getMcpFixCommand(id: string): string | undefined {
  const known = results.get(id)?.availability;
  return known?.state === 'unavailable' ? known.fixCommand : undefined;
}

/** Called with each connector whose availability changed */
export function onMcpAvailabilityChange(listener: (id: string, availability: McpAvailability) => void): () => void {
  events.on('change', listener);
  return () => events.off('change', listener);
}

function set(id: string, key: string, availability: McpAvailability): McpAvailability {
  results.set(id, { key, availability, checkedAt: Date.now() });
  // What check() reads: an open browser keeps Puppeteer unavailable whatever its server says
  events.emit('change', id, withBrowserOpen(id, availability, puppeteerSettings));
  return availability;
}

/** The chosen browser whose open state matters (a profile of the user's, not Puppeteer's download) */
function chosenProfileBrowser(settings: McpConnectorSettings | undefined): PuppeteerBrowserChoice | undefined {
  const browser = settings?.puppeteerBrowser;
  return browser && !browser.managed ? browser : undefined;
}

/** A server's availability with the chosen browser's last known open state on top */
function withBrowserOpen(id: string, availability: McpAvailability, settings: McpConnectorSettings | undefined): McpAvailability {
  const browser = id === 'puppeteer' ? chosenProfileBrowser(settings) : undefined;
  if (!browser || availability.state === 'unavailable') return availability;
  return browserOpen.get(browser.id)?.open ? { state: 'unavailable', browserOpen: true } : availability;
}

/** Remember the latest settings (the chosen browser); a poll for another browser stops */
function notePuppeteerSettings(settings: McpConnectorSettings | undefined): void {
  puppeteerSettings = settings;
  if (browserTimer && browserTimer.id !== chosenProfileBrowser(settings)?.id) {
    clearTimeout(browserTimer.timer);
    browserTimer = undefined;
  }
}

/**
 * The connectors' availability now; servers not checked yet (or whose connection details
 * changed) start being checked and read "preparing". `settings` are the latest saved ones (the
 * IPC handler reads the settings file): their Puppeteer browser becomes the chosen one
 */
export function getMcpAvailability(ids: string[], settings: McpConnectorSettings | undefined): Record<string, McpAvailability> {
  if (ids.includes('puppeteer')) notePuppeteerSettings(settings);
  return Object.fromEntries(ids.map((id) => [id, check(id, settings)]));
}

/** Why a run leaves a connector out, as a log line */
export function describeLeftOutConnector(id: string, availability: McpAvailability, settings: McpConnectorSettings | undefined): string {
  const name = BUILTIN_NAMES[id] ?? settings?.customServers?.find((server) => server.id === id)?.name ?? id;
  let reason: string;
  if (availability.browserOpen) {
    const browser = settings?.puppeteerBrowser;
    const browserName = browser ? BROWSER_NAMES[browser.browser] ?? browser.browser : 'The chosen browser';
    reason = `${browserName}${browser?.profileName ? ` (profile ${browser.profileName})` : ''} is open and has no saved copy of its profile yet. Close it once to use ${name} in later runs`;
  } else if (availability.missingCommand) {
    reason = `${availability.missingCommand} is not installed`;
  } else {
    reason = availability.message || 'its server could not start';
  }
  return `${name} connector left out of this run: ${reason}`;
}

/**
 * The connector ids a run can use: unavailable ones are left out (preparing ones stay in). The
 * run's browser is looked at now, so a run never copies the profile of an open one. Each one left
 * out is logged, passed to `onLeftOut` (the run's log) and sent to every window again, so a view
 * that still shows it on catches up. `runBrowser` is the run's own Puppeteer browser when it isn't
 * the one in `settings` (a task's own choice, TaskMetadata.puppeteerBrowser; null: Puppeteer's own
 * Chrome): only its lock is looked at, the server's check stays the one for `settings`, so a task's
 * choice never replaces the result the windows show
 */
export async function usableMcpConnectorIds(
  ids: string[],
  settings: McpConnectorSettings | undefined,
  onLeftOut?: (id: string, availability: McpAvailability) => void,
  runBrowser?: PuppeteerBrowserChoice | null
): Promise<string[]> {
  const runSettings: McpConnectorSettings | undefined = runBrowser === undefined
    ? settings
    : { ...settings, puppeteerBrowser: runBrowser ?? undefined };
  // The run's own browser (its settings may be older than the chosen one): looked at, never chosen
  const browser = chosenProfileBrowser(runSettings);
  // Its answer counts even when a reset forgot it while looking
  const browserIsOpen = browser && ids.includes('puppeteer') ? await lookAtBrowser(browser) : false;
  return ids.filter((id) => {
    const found = runBrowser === undefined || id !== 'puppeteer'
      ? check(id, settings)
      // The server's own check, without the chosen browser's open state (the run's browser counts)
      : checkServer(id, settings);
    const availability: McpAvailability = id === 'puppeteer' && browserIsOpen && found.state !== 'unavailable'
      ? { state: 'unavailable', browserOpen: true }
      : found;
    if (availability.state !== 'unavailable') return true;
    appLog.info(`[MCP] ${describeLeftOutConnector(id, availability, runSettings)}`);
    // A task's own browser being open says nothing about the one the windows show
    if (!(availability.browserOpen && runBrowser !== undefined)) events.emit('change', id, availability);
    onLeftOut?.(id, availability);
    return false;
  });
}

function check(id: string, settings: McpConnectorSettings | undefined): McpAvailability {
  const availability = checkServer(id, settings);
  const browser = id === 'puppeteer' ? chosenProfileBrowser(settings) : undefined;
  // Looks again at an old answer (the result arrives as a change)
  if (browser && availability.state !== 'unavailable') refreshBrowserOpen(browser);
  return withBrowserOpen(id, availability, settings);
}

/**
 * Look at the chosen browser again when its last answer is missing or old; while it is open, make
 * sure a look is coming (a poll stopped when another browser was chosen for a moment)
 */
function refreshBrowserOpen(browser: PuppeteerBrowserChoice): void {
  const known = browserOpen.get(browser.id);
  if (!known || Date.now() - known.checkedAt >= BROWSER_RECHECK_MS) {
    void lookAtBrowser(browser);
  } else if (known.open && isChosenBrowser(browser.id)
    && browserTimer?.id !== browser.id && !browserLooks.has(browser.id)) {
    pollBrowser(browser.id);
  }
}

function isChosenBrowser(id: string): boolean {
  return chosenProfileBrowser(puppeteerSettings)?.id === id;
}

/** Look at the chosen browser again in BROWSER_RECHECK_MS (it is open) */
function pollBrowser(id: string): void {
  if (browserTimer) clearTimeout(browserTimer.timer);
  const timer = setTimeout(() => {
    browserTimer = undefined;
    const current = chosenProfileBrowser(puppeteerSettings);
    if (current) void lookAtBrowser(current);
  }, BROWSER_RECHECK_MS);
  timer.unref();
  browserTimer = { id, timer };
}

/**
 * Look at a browser's lock and keep the answer for that browser; a change for the browser chosen
 * now is sent like any other availability change, read with the latest settings
 */
function lookAtBrowser(browser: PuppeteerBrowserChoice): Promise<boolean> {
  const running = browserLooks.get(browser.id);
  if (running) return running;
  const started = generation;
  // Open with no saved copy to use instead (an open browser with a saved copy doesn't block runs)
  const promise = browserProfileCopyBlocked(browser).catch(() => false).then((open) => {
    if (browserLooks.get(browser.id) === promise) browserLooks.delete(browser.id);
    if (started !== generation) return open;
    const changed = (browserOpen.get(browser.id)?.open ?? false) !== open;
    browserOpen.set(browser.id, { open, checkedAt: Date.now() });
    // Not the chosen browser (a run's older choice, or the choice changed while looking): nothing to send
    if (!isChosenBrowser(browser.id)) return open;
    if (changed) events.emit('change', 'puppeteer', check('puppeteer', puppeteerSettings));
    // While it is open, keep looking, so closing it enables the connector
    if (open) {
      pollBrowser(browser.id);
    } else if (browserTimer) {
      clearTimeout(browserTimer.timer);
      browserTimer = undefined;
    }
    return open;
  });
  browserLooks.set(browser.id, promise);
  return promise;
}

/**
 * What a probe is shared by: the server's entry and the call that verifies it (a server only
 * started never vouches for one that must also do its work)
 */
function probeKey(entry: McpServerEntry, verify: VerifyCall | undefined): string {
  return JSON.stringify([entry, verify ? { name: verify.name, arguments: verify.arguments, fix: !!verify.fix } : null]);
}

function checkServer(id: string, settings: McpConnectorSettings | undefined): McpAvailability {
  const entry = mcpServerEntry(id, settings);
  if (!entry) return { state: 'ready' };
  const verify = verifyCall(id, settings);
  const key = probeKey(entry, verify);
  const known = results.get(id);
  if (known?.key === key) {
    const stale = known.availability.state === 'unavailable' && Date.now() - known.checkedAt >= UNAVAILABLE_RECHECK_MS;
    // Checked again in the background: it reads unavailable (and runs leave it out) until then
    if (stale && !probes.has(key)) startProbe(key, entry, verify, true);
    return known.availability;
  }
  // These details are the connector's current ones from now on (preparing while a probe runs, which
  // may be one started for them earlier: switching A -> B -> A keeps A's first probe)
  set(id, key, { state: 'preparing' });
  if (!probes.has(key)) startProbe(key, entry, verify, false);
  return { state: 'preparing' };
}

function startProbe(key: string, entry: McpServerEntry, verify: VerifyCall | undefined, recheck: boolean): void {
  const started = generation;
  const probe = probeEntry(entry, verify, recheck).catch((error: unknown) => ({
    state: 'unavailable' as const,
    message: error instanceof Error ? error.message : String(error),
  }));
  probes.set(key, probe);
  void probe.then((availability) => {
    if (started !== generation) return;
    probes.delete(key);
    // Every connector whose current connection details these are (another connector with the same
    // details waited on this probe), not only the one that started it
    for (const [otherId, known] of [...results]) {
      if (known.key === key) set(otherId, key, availability);
    }
  });
}

/**
 * Check a connector again now, whatever its result's age (a fix finished: Puppeteer's Chrome was
 * downloaded). It reads "preparing" until the new check ends, and every window is told
 */
export function recheckMcpConnector(id: string, settings: McpConnectorSettings | undefined): void {
  results.delete(id);
  getMcpAvailability([id], settings);
}

/**
 * Forget every result and command lookup, and stop the probes running now: the next request
 * checks again. For when tool paths change (Node.js path, shell runtime)
 */
export function resetMcpAvailability(): void {
  generation++;
  results.clear();
  probes.clear();
  browserOpen.clear();
  browserLooks.clear();
  if (browserTimer) clearTimeout(browserTimer.timer);
  browserTimer = undefined;
  resetCommandLookups();
  stopMcpProbes();
}

/**
 * Stop every probe's server and what it started (on app quit: the servers are detached, so
 * nothing else stops them). Nothing is waited for
 */
export function stopMcpProbes(): void {
  for (const proc of running) stopServer(proc);
}

function stopServer(proc: ChildProcess): void {
  running.delete(proc);
  // An MCP server ends when its input closes; the process tree is stopped as well
  try {
    proc.stdin?.end();
  } catch {
    // Already closed
  }
  killRuntimeProcessTree(proc);
}

async function probeEntry(entry: McpServerEntry, verify: VerifyCall | undefined, refresh: boolean): Promise<McpAvailability> {
  if (entry.type === 'http') return probeHttp(entry.url, entry.headers);

  await whenShellRuntimeReady();
  // The command's full path where the server runs: inside the distribution in WSL; natively on
  // Windows with its extension (`npx.cmd`), which spawn needs and then starts through a shell
  const command = await resolveCommand(entry.command, { refresh });
  if (!command) return { state: 'unavailable', missingCommand: entry.command };
  // Natively with the PATH Claude Code runs get (Node.js found through version managers too);
  // in WSL the distribution's login PATH applies
  const baseEnv = getWslInfo() ? process.env : await getToolEnvAsync();
  return startAndInitialize(command, entry.args ?? [], entry.env, baseEnv, verify);
}

async function probeHttp(url: string, headers: Record<string, string> | undefined): Promise<McpAvailability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
    // Any answer below 500 means the server is there (MCP endpoints often refuse a plain GET)
    return response.status < 500
      ? { state: 'ready' }
      : { state: 'unavailable', message: `HTTP ${response.status}` };
  } catch (error) {
    return { state: 'unavailable', message: controller.signal.aborted ? 'No answer' : error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function withFixCommand(availability: McpAvailability, fixCommand: string | undefined): McpAvailability {
  return fixCommand ? { ...availability, fixCommand } : availability;
}

/** The first sentence of an error (Puppeteer's go on with installation hints) */
function firstSentence(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  return firstLine.split(/\.\s+(?=[A-Z])/)[0].replace(/\.$/, '');
}

/**
 * Start a stdio server and wait for its answer to `initialize` (and to the verifying tool call,
 * when the server has one), then stop it
 */
function startAndInitialize(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  baseEnv: NodeJS.ProcessEnv,
  verify?: VerifyCall
): Promise<McpAvailability> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnTool('python', args, {
        command,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...baseEnv, ...env },
        windowsHide: true,
        // Its own process group, so the server npx starts (and the browser it opens) can be stopped
        // with it; on Windows its tree is stopped with taskkill
        detached: !isWindows(),
      });
    } catch (error) {
      resolve({ state: 'unavailable', message: error instanceof Error ? error.message : String(error) });
      return;
    }

    running.add(proc);
    // Writing to (or closing) the input of a server that already exited must not throw
    proc.stdin?.on('error', () => undefined);
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (availability: McpAvailability) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Unless stopMcpProbes already stopped it
      if (running.has(proc)) stopServer(proc);
      resolve(availability);
    };
    const timer = setTimeout(() => finish({ state: 'unavailable', message: 'Did not start in time' }), START_TIMEOUT_MS);

    const send = (message: Record<string, unknown>) => proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    let initialized = false;
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        let message: { id?: unknown; result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Not a JSON-RPC line (some servers log to stdout)
        }
        if (message.id === 1 && message.result && !initialized) {
          initialized = true;
          if (!verify) {
            finish({ state: 'ready' });
            return;
          }
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/call', params: { name: verify.name, arguments: verify.arguments } });
        } else if (message.id === 2) {
          const failure = message.error?.message
            ?? (message.result?.isError ? message.result.content?.map((part) => part.text ?? '').join(' ') : undefined);
          finish(failure === undefined
            ? { state: 'ready' }
            : withFixCommand({ state: 'unavailable', message: firstSentence(failure) || 'Failed' }, verify?.fix?.(failure)));
          return;
        }
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString('utf-8')).slice(-2000);
    });
    proc.on('error', (error) => finish({ state: 'unavailable', message: error.message }));
    proc.on('close', (code) => {
      const lastLine = stderr.trim().split('\n').filter(Boolean).at(-1);
      finish({ state: 'unavailable', message: lastLine || `Exited with code ${code ?? 'unknown'}` });
    });

    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'workbench', version: '1.0.0' } },
    });
  });
}
