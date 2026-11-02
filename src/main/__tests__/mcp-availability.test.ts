import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/** Installed commands and where they are */
const installed = new Map<string, string>();
const servers: Record<string, (proc: FakeProcess) => void> = {};

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
}

const mocks = vi.hoisted(() => ({
  windows: false,
  browserOpen: false,
  inUse: vi.fn(),
  spawnTool: vi.fn(),
  killRuntimeProcessTree: vi.fn(),
  resolveCommand: vi.fn(),
  resetCommandLookups: vi.fn(),
}));

vi.mock('../mcp-commands', () => ({
  resolveCommand: mocks.resolveCommand,
  resetCommandLookups: mocks.resetCommandLookups,
}));
vi.mock('../platform/shell-runtime', () => ({ getWslInfo: () => null, whenShellRuntimeReady: async () => undefined }));
vi.mock('../platform/runtime-exec', () => ({
  spawnTool: mocks.spawnTool,
  killRuntimeProcessTree: mocks.killRuntimeProcessTree,
  toRuntimeArg: (arg: string) => arg,
}));
vi.mock('../platform', () => ({ isWindows: () => mocks.windows }));
vi.mock('../cli-utils', () => ({ getToolEnvAsync: async () => ({ PATH: '/usr/bin' }) }));
vi.mock('../browser-profiles/profile-copy', () => ({ browserProfileCopyBlocked: (browser: unknown) => mocks.inUse(browser) }));
vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn() } }));

let getMcpAvailability: typeof import('../mcp-availability').getMcpAvailability;
let onMcpAvailabilityChange: typeof import('../mcp-availability').onMcpAvailabilityChange;
let usableMcpConnectorIds: typeof import('../mcp-availability').usableMcpConnectorIds;
let resetMcpAvailability: typeof import('../mcp-availability').resetMcpAvailability;
let stopMcpProbes: typeof import('../mcp-availability').stopMcpProbes;
let UNAVAILABLE_RECHECK_MS: number;
let describeLeftOutConnector: typeof import('../mcp-availability').describeLeftOutConnector;

const answer = (proc: FakeProcess) => proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
const crash = (proc: FakeProcess) => {
  proc.stderr.emit('data', Buffer.from('npm error 404 Not Found\n'));
  proc.emit('close', 1);
};

describe('MCP availability', () => {
  // Results are kept for the app session: each test starts with none
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    installed.clear();
    for (const key of Object.keys(servers)) delete servers[key];
    mocks.windows = false;
    mocks.browserOpen = false;
    mocks.inUse.mockImplementation(async () => mocks.browserOpen);
    mocks.resolveCommand.mockImplementation(async (command: string) => installed.get(command) ?? null);
    mocks.spawnTool.mockImplementation((_tool: string, args: string[]) => {
      const proc = new FakeProcess();
      setTimeout(() => servers[args.join(' ')]?.(proc), 0);
      return proc;
    });
    vi.resetModules();
    ({
      getMcpAvailability, onMcpAvailabilityChange, usableMcpConnectorIds, resetMcpAvailability, stopMcpProbes, UNAVAILABLE_RECHECK_MS,
      describeLeftOutConnector,
    } = await import('../mcp-availability'));
  });

  it('is preparing until the server answers, then ready or unavailable', async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @upstash/context7-mcp@latest'] = answer;
    servers['-y @modelcontextprotocol/server-puppeteer'] = crash;
    const changes: Record<string, string> = {};
    const stop = onMcpAvailabilityChange((id, availability) => {
      changes[id] = availability.state;
    });

    expect(getMcpAvailability(['context7', 'puppeteer'], undefined)).toEqual({
      context7: { state: 'preparing' },
      puppeteer: { state: 'preparing' },
    });
    // A run still includes servers being prepared
    expect(await usableMcpConnectorIds(['context7', 'puppeteer'], undefined)).toEqual(['context7', 'puppeteer']);

    await vi.waitFor(() => expect(changes).toEqual({ context7: 'ready', puppeteer: 'unavailable' }));
    expect(getMcpAvailability(['puppeteer'], undefined).puppeteer).toEqual({ state: 'unavailable', message: 'npm error 404 Not Found' });
    // ...and leaves out the ones that can't start
    expect(await usableMcpConnectorIds(['context7', 'puppeteer'], undefined)).toEqual(['context7']);
    stop();
  });

  it("checks Puppeteer's browser and says how to install it", async () => {
    installed.set('npx', '/usr/bin/npx');
    const calls: unknown[] = [];
    servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
      proc.stdin.write.mockImplementation((line: string) => {
        const message = JSON.parse(line);
        calls.push(message);
        if (message.method === 'tools/call') {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            error: { code: -32603, message: 'Could not find Chrome (ver. 131.0.6778.204). This can occur if either\n 1. you did not install it' },
          }) + '\n'));
        }
      });
      answer(proc);
    };
    const settings = { customServers: [] };
    getMcpAvailability(['puppeteer'], settings);
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], settings).puppeteer.state).toBe('unavailable'));
    expect(getMcpAvailability(['puppeteer'], settings).puppeteer).toEqual({
      state: 'unavailable',
      message: 'Could not find Chrome (ver. 131.0.6778.204)',
      fixCommand: 'npx puppeteer browsers install chrome@131.0.6778.204',
    });
    // It opened a blank page in a hidden browser
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'tools/call',
      params: { name: 'puppeteer_navigate', arguments: { url: 'about:blank', launchOptions: { headless: true } } },
    }));
  });

  it('checks the chosen browser, offers no install command, and checks again for another choice', async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
      proc.stdin.write.mockImplementation((line: string) => {
        if (JSON.parse(line).method === 'tools/call') {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            error: { code: -32603, message: 'Browser was not found at the configured executablePath (/opt/gone/chrome)' },
          }) + '\n'));
        }
      });
      answer(proc);
    };
    const choice = {
      id: 'chrome:Default', browser: 'chrome' as const, engine: 'chromium' as const, profileName: 'Me',
      executablePath: '/opt/gone/chrome', userDataDir: '/home/me/.config/google-chrome', profileDirectory: 'Default',
      profilePath: '/home/me/.config/google-chrome/Default',
    };
    const settings = { puppeteerBrowser: choice };
    getMcpAvailability(['puppeteer'], settings);
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], settings).puppeteer.state).toBe('unavailable'));
    expect(getMcpAvailability(['puppeteer'], settings).puppeteer).toEqual({
      state: 'unavailable',
      message: 'Browser was not found at the configured executablePath (/opt/gone/chrome)',
    });
    // The chosen executable reaches the server, never a profile folder
    const env = mocks.spawnTool.mock.calls[0][2].env as Record<string, string>;
    expect(JSON.parse(env.PUPPETEER_LAUNCH_OPTIONS)).toEqual({ defaultViewport: null, executablePath: '/opt/gone/chrome' });

    servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
      proc.stdin.write.mockImplementation((line: string) => {
        if (JSON.parse(line).method === 'tools/call') {
          proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"content":[]}}\n'));
        }
      });
      answer(proc);
    };
    const other = { puppeteerBrowser: { ...choice, id: 'chrome:Profile 1', executablePath: '/opt/google/chrome/chrome' } };
    expect(getMcpAvailability(['puppeteer'], other).puppeteer).toEqual({ state: 'preparing' });
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], other).puppeteer.state).toBe('ready'));
  });

  it('names the missing command', async () => {
    const settings = { customServers: [{ id: 'py', name: 'Py', type: 'command' as const, command: 'uvx', args: ['tool'], verified: true }] };
    getMcpAvailability(['py'], settings);
    await vi.waitFor(() => expect(getMcpAvailability(['py'], settings).py).toEqual({ state: 'unavailable', missingCommand: 'uvx' }));
  });

  it("starts npm's .cmd shim on Windows by its full path, without a process group", async () => {
    mocks.windows = true;
    installed.set('npx', 'C:\\Program Files\\nodejs\\npx.cmd');
    servers['-y @upstash/context7-mcp@latest'] = answer;
    getMcpAvailability(['context7'], undefined);
    await vi.waitFor(() => expect(getMcpAvailability(['context7'], undefined).context7.state).toBe('ready'));
    expect(mocks.spawnTool).toHaveBeenCalledWith('python', ['-y', '@upstash/context7-mcp@latest'], expect.objectContaining({
      command: 'C:\\Program Files\\nodejs\\npx.cmd',
      detached: false,
    }));
  });

  it('starts the server in its own process group and stops the whole group', async () => {
    installed.set('npx', '/home/me/.nvm/versions/node/v22/bin/npx');
    let started: FakeProcess | undefined;
    servers['-y @upstash/context7-mcp@latest'] = (proc) => {
      started = proc;
      answer(proc);
    };
    getMcpAvailability(['context7'], undefined);
    await vi.waitFor(() => expect(getMcpAvailability(['context7'], undefined).context7.state).toBe('ready'));
    expect(mocks.spawnTool).toHaveBeenCalledWith('python', ['-y', '@upstash/context7-mcp@latest'], expect.objectContaining({
      command: '/home/me/.nvm/versions/node/v22/bin/npx',
      detached: true,
    }));
    expect(started?.stdin.end).toHaveBeenCalled();
    expect(mocks.killRuntimeProcessTree).toHaveBeenCalledWith(started);
  });

  it('stops probes still running (on app quit)', async () => {
    installed.set('npx', '/usr/bin/npx');
    // A server that never answers
    servers['-y @modelcontextprotocol/server-puppeteer'] = () => undefined;
    getMcpAvailability(['puppeteer'], undefined);
    await vi.waitFor(() => expect(mocks.spawnTool).toHaveBeenCalledTimes(1));
    const proc = mocks.spawnTool.mock.results[0].value as FakeProcess;
    stopMcpProbes();
    expect(mocks.killRuntimeProcessTree).toHaveBeenCalledWith(proc);
    // Its exit doesn't stop it a second time
    proc.emit('close', null);
    expect(mocks.killRuntimeProcessTree).toHaveBeenCalledTimes(1);
  });

  it('checks an unavailable server again after a while, keeping ready ones', async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @upstash/context7-mcp@latest'] = answer;
    servers['-y @modelcontextprotocol/server-puppeteer'] = crash;
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    getMcpAvailability(['context7', 'puppeteer'], undefined);
    await vi.waitFor(async () => expect(await usableMcpConnectorIds(['context7', 'puppeteer'], undefined)).toEqual(['context7']));
    expect(mocks.spawnTool).toHaveBeenCalledTimes(2);

    // The user fixed it (the browser opens now): nothing is checked again right away
    servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
      proc.stdin.write.mockImplementation((line: string) => {
        if (JSON.parse(line).method === 'tools/call') proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'));
      });
      answer(proc);
    };
    getMcpAvailability(['context7', 'puppeteer'], undefined);
    expect(mocks.spawnTool).toHaveBeenCalledTimes(2);

    now += UNAVAILABLE_RECHECK_MS;
    // It still reads unavailable (and stays out of runs) while it is checked again...
    expect(getMcpAvailability(['context7', 'puppeteer'], undefined).puppeteer.state).toBe('unavailable');
    expect(await usableMcpConnectorIds(['context7', 'puppeteer'], undefined)).toEqual(['context7']);
    // ...with the command looked up again
    await vi.waitFor(() => expect(mocks.resolveCommand).toHaveBeenLastCalledWith('npx', { refresh: true }));
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], undefined).puppeteer.state).toBe('ready'));
    // Only the unavailable server was started again
    expect(mocks.spawnTool).toHaveBeenCalledTimes(3);
  });

  it('forgets every result and command lookup on reset', async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @upstash/context7-mcp@latest'] = answer;
    getMcpAvailability(['context7'], undefined);
    await vi.waitFor(() => expect(getMcpAvailability(['context7'], undefined).context7.state).toBe('ready'));

    resetMcpAvailability();
    expect(mocks.resetCommandLookups).toHaveBeenCalled();
    expect(getMcpAvailability(['context7'], undefined).context7).toEqual({ state: 'preparing' });
    await vi.waitFor(() => expect(getMcpAvailability(['context7'], undefined).context7.state).toBe('ready'));
    expect(mocks.spawnTool).toHaveBeenCalledTimes(2);
  });

  it("ignores a probe's result that a reset made stale", async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @modelcontextprotocol/server-puppeteer'] = () => undefined;
    getMcpAvailability(['puppeteer'], undefined);
    await vi.waitFor(() => expect(mocks.spawnTool).toHaveBeenCalledTimes(1));
    const first = mocks.spawnTool.mock.results[0].value as FakeProcess;

    servers['-y @modelcontextprotocol/server-puppeteer'] = answer;
    resetMcpAvailability();
    expect(mocks.killRuntimeProcessTree).toHaveBeenCalledWith(first);
    getMcpAvailability(['puppeteer'], undefined);
    // The stopped probe exits without an answer, which must not count
    first.emit('close', null);
    await vi.waitFor(() => expect(mocks.spawnTool).toHaveBeenCalledTimes(2));
    const second = mocks.spawnTool.mock.results[1].value as FakeProcess;
    // Puppeteer also needs its tool call answered
    second.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'));
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], undefined).puppeteer.state).toBe('ready'));
  });
  it("leaves Puppeteer out while its chosen browser is open, and back in once it's closed", async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
      proc.stdin.write.mockImplementation((line: string) => {
        if (JSON.parse(line).method === 'tools/call') proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'));
      });
      answer(proc);
    };
    const settings = {
      puppeteerBrowser: {
        id: 'firefox:x.default', browser: 'firefox' as const, engine: 'firefox' as const, profileName: 'default',
        executablePath: '/usr/lib/firefox/firefox', userDataDir: '/home/me/.mozilla/firefox', profilePath: '/home/me/.mozilla/firefox/x.default',
      },
    };
    getMcpAvailability(['puppeteer'], settings);
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], settings).puppeteer.state).toBe('ready'));

    mocks.browserOpen = true;
    expect(await usableMcpConnectorIds(['puppeteer'], settings)).toEqual([]);
    expect(getMcpAvailability(['puppeteer'], settings).puppeteer).toEqual({ state: 'unavailable', browserOpen: true });

    mocks.browserOpen = false;
    expect(await usableMcpConnectorIds(['puppeteer'], settings)).toEqual(['puppeteer']);
    stopMcpProbes();
  });

  const firefoxProfile = {
    id: 'firefox:x.default', browser: 'firefox' as const, engine: 'firefox' as const, profileName: 'default',
    executablePath: '/usr/lib/firefox/firefox', userDataDir: '/home/me/.mozilla/firefox', profilePath: '/home/me/.mozilla/firefox/x.default',
  };

  it("keeps Puppeteer unavailable when its probe ends while the chosen browser is open", async () => {
    installed.set('npx', '/usr/bin/npx');
    let finishProbe: (() => void) | undefined;
    servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
      proc.stdin.write.mockImplementation((line: string) => {
        if (JSON.parse(line).method === 'tools/call') {
          finishProbe = () => proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'));
        }
      });
      answer(proc);
    };
    mocks.browserOpen = true;
    const settings = { puppeteerBrowser: firefoxProfile };
    const changes: unknown[] = [];
    const stop = onMcpAvailabilityChange((_id, availability) => changes.push(availability));

    getMcpAvailability(['puppeteer'], settings);
    await vi.waitFor(() => expect(changes).toContainEqual({ state: 'unavailable', browserOpen: true }));
    await vi.waitFor(() => expect(finishProbe).toBeDefined());
    const before = changes.length;
    finishProbe?.();
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(before));
    // The server is fine, but the open browser still keeps it out
    expect(changes.at(-1)).toEqual({ state: 'unavailable', browserOpen: true });
    expect(getMcpAvailability(['puppeteer'], settings).puppeteer).toEqual({ state: 'unavailable', browserOpen: true });
    stop();
    stopMcpProbes();
  });

  it('stops looking at an open browser once another one is chosen', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      installed.set('npx', '/usr/bin/npx');
      servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
        proc.stdin.write.mockImplementation((line: string) => {
          if (JSON.parse(line).method === 'tools/call') proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n'));
        });
        answer(proc);
      };
      mocks.browserOpen = true;
      const profile = { puppeteerEnabled: true, puppeteerBrowser: firefoxProfile };
      getMcpAvailability(['puppeteer'], profile);
      await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], profile).puppeteer).toEqual({ state: 'unavailable', browserOpen: true }));

      // Puppeteer's own Firefox is chosen, then the profile's browser closes
      const managed = {
        puppeteerEnabled: true,
        puppeteerBrowser: {
          ...firefoxProfile, id: 'puppeteer:firefox', managed: true, executablePath: '/home/me/.cache/puppeteer/firefox/firefox',
        },
      };
      const changes: unknown[] = [];
      const stop = onMcpAvailabilityChange((_id, availability) => changes.push(availability));
      getMcpAvailability(['puppeteer'], managed);
      await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], managed).puppeteer.state).toBe('ready'));
      mocks.browserOpen = false;
      const looks = mocks.inUse.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);

      // The old profile isn't looked at again, and nothing goes back to its entry
      expect(mocks.inUse.mock.calls.length).toBe(looks);
      expect(changes.at(-1)).toEqual({ state: 'ready' });
      const lastSpawn = mocks.spawnTool.mock.calls.at(-1)?.[2].env as Record<string, string>;
      expect(JSON.parse(lastSpawn.PUPPETEER_LAUNCH_OPTIONS).executablePath).toBe('/home/me/.cache/puppeteer/firefox/firefox');
      stop();
      stopMcpProbes();
    } finally {
      vi.useRealTimers();
    }
  });
  /** A Puppeteer server whose browser call fails with `error`, or succeeds without one */
  const puppeteerServer = (error?: string) => (proc: FakeProcess) => {
    proc.stdin.write.mockImplementation((line: string) => {
      if (JSON.parse(line).method !== 'tools/call') return;
      proc.stdout.emit('data', Buffer.from(JSON.stringify(error
        ? { jsonrpc: '2.0', id: 2, error: { code: -32603, message: error } }
        : { jsonrpc: '2.0', id: 2, result: {} }) + '\n'));
    });
    answer(proc);
  };

  it("offers a download only when Puppeteer's browser isn't downloaded", async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @modelcontextprotocol/server-puppeteer'] = puppeteerServer(
      'Failed to launch the browser process! [0101/000000.000:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox!'
    );
    getMcpAvailability(['puppeteer'], undefined);
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], undefined).puppeteer.state).toBe('unavailable'));
    const launchFailure = getMcpAvailability(['puppeteer'], undefined).puppeteer;
    expect(launchFailure.fixCommand).toBeUndefined();
    expect(launchFailure.message).toContain('Failed to launch the browser process');

    resetMcpAvailability();
    servers['-y @modelcontextprotocol/server-puppeteer'] = puppeteerServer('Could not find Firefox (rev. 133.0). This can occur if');
    getMcpAvailability(['puppeteer'], undefined);
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], undefined).puppeteer.state).toBe('unavailable'));
    expect(getMcpAvailability(['puppeteer'], undefined).puppeteer.fixCommand).toBe('npx puppeteer browsers install firefox');
  });

  it('keeps the latest choice when the browser is switched back while its first check runs', async () => {
    installed.set('npx', '/usr/bin/npx');
    // Each probe waits until the test answers it
    const pending: Array<() => void> = [];
    servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
      proc.stdin.write.mockImplementation((line: string) => {
        if (JSON.parse(line).method === 'tools/call') {
          pending.push(() => proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,"result":{}}\n')));
        }
      });
      answer(proc);
    };
    const a = { puppeteerBrowser: { ...firefoxProfile, id: 'puppeteer:firefox', managed: true, executablePath: '/a/firefox' } };
    const b = { puppeteerBrowser: { ...firefoxProfile, id: 'puppeteer:chrome', managed: true, executablePath: '/b/chrome' } };
    const changes: string[] = [];
    const stop = onMcpAvailabilityChange((_id, availability) => changes.push(availability.state));

    expect(getMcpAvailability(['puppeteer'], a).puppeteer.state).toBe('preparing');
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(getMcpAvailability(['puppeteer'], b).puppeteer.state).toBe('preparing');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // Back to A, whose first check is still running: no second check of A
    expect(getMcpAvailability(['puppeteer'], a).puppeteer.state).toBe('preparing');
    expect(mocks.spawnTool).toHaveBeenCalledTimes(2);

    // B finishes first: it no longer counts
    pending[1]();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getMcpAvailability(['puppeteer'], a).puppeteer.state).toBe('preparing');
    expect(changes.at(-1)).toBe('preparing');
    // A's result is the one kept and sent
    pending[0]();
    await vi.waitFor(() => expect(changes.at(-1)).toBe('ready'));
    expect(getMcpAvailability(['puppeteer'], a).puppeteer.state).toBe('ready');
    stop();
    stopMcpProbes();
  });

  it('keeps looking at an open browser chosen again within moments', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      installed.set('npx', '/usr/bin/npx');
      servers['-y @modelcontextprotocol/server-puppeteer'] = puppeteerServer();
      mocks.browserOpen = true;
      const profile = { puppeteerEnabled: true, puppeteerBrowser: firefoxProfile };
      const managed = { puppeteerEnabled: true, puppeteerBrowser: { ...firefoxProfile, id: 'puppeteer:firefox', managed: true, executablePath: '/m/firefox' } };
      getMcpAvailability(['puppeteer'], profile);
      await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], profile).puppeteer).toEqual({ state: 'unavailable', browserOpen: true }));

      // Another choice stops the poll; choosing the profile again right away (its open state is
      // still fresh) starts it again
      getMcpAvailability(['puppeteer'], managed);
      getMcpAvailability(['puppeteer'], profile);
      const changes: unknown[] = [];
      const stop = onMcpAvailabilityChange((_id, availability) => changes.push(availability));
      mocks.browserOpen = false;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(changes).toContainEqual(expect.objectContaining({ state: expect.not.stringMatching('unavailable') })));
      expect(getMcpAvailability(['puppeteer'], profile).puppeteer.browserOpen).toBeUndefined();
      stop();
      stopMcpProbes();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells a run, the log and every window when it leaves a connector out', async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @modelcontextprotocol/server-puppeteer'] = puppeteerServer();
    const settings = { puppeteerBrowser: firefoxProfile };
    getMcpAvailability(['puppeteer'], settings);
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], settings).puppeteer.state).toBe('ready'));

    mocks.browserOpen = true;
    const changes: unknown[] = [];
    const stop = onMcpAvailabilityChange((id, availability) => changes.push([id, availability]));
    const leftOut: unknown[] = [];
    expect(await usableMcpConnectorIds(['puppeteer'], settings, (id, availability) => leftOut.push([id, availability]))).toEqual([]);
    expect(leftOut).toEqual([['puppeteer', { state: 'unavailable', browserOpen: true }]]);
    expect(changes).toContainEqual(['puppeteer', { state: 'unavailable', browserOpen: true }]);
    const { appLog } = await import('../app-logger');
    expect(appLog.info).toHaveBeenCalledWith(expect.stringContaining('Puppeteer connector left out of this run: Firefox (profile default) is open'));
    stop();
    stopMcpProbes();
  });

  it('leaves Puppeteer out when its browser is open even if a reset forgot the answer', async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @modelcontextprotocol/server-puppeteer'] = puppeteerServer();
    const settings = { puppeteerBrowser: firefoxProfile };
    let answerLook: ((open: boolean) => void) | undefined;
    mocks.inUse.mockImplementation(() => new Promise<boolean>((resolve) => { answerLook = resolve; }));
    const usable = usableMcpConnectorIds(['puppeteer'], settings);
    await vi.waitFor(() => expect(answerLook).toBeDefined());
    // Tool paths changed while the lock was looked at
    resetMcpAvailability();
    answerLook?.(true);
    expect(await usable).toEqual([]);
    stopMcpProbes();
  });

  it('describes why a connector was left out', () => {
    expect(describeLeftOutConnector('py', { state: 'unavailable', missingCommand: 'uvx' }, {
      customServers: [{ id: 'py', name: 'Py tools', type: 'command', command: 'uvx' }],
    })).toBe('Py tools connector left out of this run: uvx is not installed');
    expect(describeLeftOutConnector('context7', { state: 'unavailable', message: 'npm error 404' }, undefined))
      .toBe('Context7 connector left out of this run: npm error 404');
  });

  it('gives a probe\'s result to every connector with the same connection details', async () => {
    installed.set('npx', '/usr/bin/npx');
    let finish: (() => void) | undefined;
    servers['-y @upstash/context7-mcp@latest'] = (proc) => {
      finish = () => answer(proc);
    };
    // A custom server with the built-in Context7's command, and two HTTP servers with one URL
    const settings = {
      customServers: [
        { id: 'my-context7', name: 'My Context7', type: 'command' as const, command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'], verified: true },
      ],
    };
    const changes: Array<[string, string]> = [];
    const stop = onMcpAvailabilityChange((id, availability) => changes.push([id, availability.state]));
    expect(getMcpAvailability(['context7', 'my-context7'], settings)).toEqual({
      context7: { state: 'preparing' },
      'my-context7': { state: 'preparing' },
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    // One probe for both
    expect(mocks.spawnTool).toHaveBeenCalledTimes(1);
    finish?.();
    await vi.waitFor(() => expect(getMcpAvailability(['my-context7'], settings)['my-context7'].state).toBe('ready'));
    expect(getMcpAvailability(['context7'], settings).context7.state).toBe('ready');
    expect(changes).toContainEqual(['context7', 'ready']);
    expect(changes).toContainEqual(['my-context7', 'ready']);
    stop();

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 405 }));
    const http = {
      customServers: [
        { id: 'one', name: 'One', type: 'http' as const, url: 'http://localhost:9000/mcp', verified: true },
        { id: 'two', name: 'Two', type: 'http' as const, url: 'http://localhost:9000/mcp', verified: true },
      ],
    };
    getMcpAvailability(['one', 'two'], http);
    await vi.waitFor(() => expect(getMcpAvailability(['one', 'two'], http)).toEqual({ one: { state: 'ready' }, two: { state: 'ready' } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  const chromeProfile = {
    id: 'chrome:Default', browser: 'chrome' as const, engine: 'chromium' as const, profileName: 'Default',
    executablePath: '/usr/bin/google-chrome', userDataDir: '/home/me/.config/google-chrome', profilePath: '/home/me/.config/google-chrome/Default',
  };

  it("keeps each browser's open state: a late look at the old choice doesn't change the new one's", async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @modelcontextprotocol/server-puppeteer'] = puppeteerServer();
    const looks = new Map<string, (open: boolean) => void>();
    mocks.inUse.mockImplementation((browser: { id: string }) => new Promise<boolean>((resolve) => looks.set(browser.id, resolve)));
    const a = { puppeteerBrowser: firefoxProfile };
    const b = { puppeteerBrowser: chromeProfile };

    getMcpAvailability(['puppeteer'], a);
    getMcpAvailability(['puppeteer'], b);
    await vi.waitFor(() => expect([...looks.keys()]).toEqual([firefoxProfile.id, chromeProfile.id]));
    looks.get(chromeProfile.id)?.(false);
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], b).puppeteer.state).toBe('ready'));
    // A (no longer chosen) turns out open: B stays usable
    looks.get(firefoxProfile.id)?.(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getMcpAvailability(['puppeteer'], b).puppeteer).toEqual({ state: 'ready' });
    stopMcpProbes();
  });

  it("lets a run with older settings look at its browser without changing the chosen one", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      installed.set('npx', '/usr/bin/npx');
      servers['-y @modelcontextprotocol/server-puppeteer'] = puppeteerServer();
      const open = new Set<string>([chromeProfile.id]);
      mocks.inUse.mockImplementation(async (browser: { id: string }) => open.has(browser.id));
      const older = { puppeteerEnabled: true, puppeteerBrowser: firefoxProfile };
      const latest = { puppeteerEnabled: true, puppeteerBrowser: chromeProfile };
      // The user chose B (open): it is looked at every few seconds
      getMcpAvailability(['puppeteer'], latest);
      await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], latest).puppeteer).toEqual({ state: 'unavailable', browserOpen: true }));

      // A run started with A looks at A only
      expect(await usableMcpConnectorIds(['puppeteer'], older)).toEqual(['puppeteer']);
      const changes: unknown[] = [];
      const stop = onMcpAvailabilityChange((_id, availability) => changes.push(availability));
      // B's poll goes on: closing B enables the connector
      open.clear();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.inUse.mock.calls.filter(([browser]) => browser.id === chromeProfile.id).length).toBeGreaterThan(1);
      await vi.waitFor(() => expect(changes.at(-1)).toEqual(expect.objectContaining({ state: expect.not.stringMatching('unavailable') })));
      stop();
      stopMcpProbes();
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks at a task's own browser for its run, leaving the windows' result alone", async () => {
    installed.set('npx', '/usr/bin/npx');
    servers['-y @modelcontextprotocol/server-puppeteer'] = puppeteerServer();
    const open = new Set<string>();
    mocks.inUse.mockImplementation(async (browser: { id: string }) => open.has(browser.id));
    const settings = { puppeteerEnabled: true, puppeteerBrowser: chromeProfile };
    getMcpAvailability(['puppeteer'], settings);
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], settings).puppeteer.state).toBe('ready'));

    // The task's browser is open: its run leaves Puppeteer out, the windows still read it ready
    open.add(firefoxProfile.id);
    const changes: unknown[] = [];
    const stop = onMcpAvailabilityChange((_id, availability) => changes.push(availability));
    expect(await usableMcpConnectorIds(['puppeteer'], settings, undefined, firefoxProfile)).toEqual([]);
    expect(changes).not.toContainEqual({ state: 'unavailable', browserOpen: true });
    expect(getMcpAvailability(['puppeteer'], settings).puppeteer.state).toBe('ready');

    // The Settings browser is open, the task's isn't (or the task uses Puppeteer's own Chrome)
    open.clear();
    open.add(chromeProfile.id);
    expect(await usableMcpConnectorIds(['puppeteer'], settings)).toEqual([]);
    expect(await usableMcpConnectorIds(['puppeteer'], settings, undefined, firefoxProfile)).toEqual(['puppeteer']);
    expect(await usableMcpConnectorIds(['puppeteer'], settings, undefined, null)).toEqual(['puppeteer']);
    stop();
    stopMcpProbes();
  });

  it('keeps looking at an open browser while Puppeteer is off, so closing it enables the switch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      installed.set('npx', '/usr/bin/npx');
      servers['-y @modelcontextprotocol/server-puppeteer'] = puppeteerServer();
      mocks.browserOpen = true;
      // Off by default: its switch is disabled while the browser is open, so it can't be switched on first
      const off = { puppeteerBrowser: firefoxProfile };
      const changes: Array<[string, string]> = [];
      const stop = onMcpAvailabilityChange((id, availability) => changes.push([id, availability.state]));
      getMcpAvailability(['puppeteer'], off);
      await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], off).puppeteer).toEqual({ state: 'unavailable', browserOpen: true }));
      const looks = mocks.inUse.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.inUse.mock.calls.length).toBeGreaterThan(looks + 1);

      // Closed: the next look sends the change, with no window asking again
      changes.length = 0;
      mocks.browserOpen = false;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(changes).toContainEqual(['puppeteer', 'ready']);
      // And the looks stop once it is closed
      const closedLooks = mocks.inUse.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.inUse.mock.calls.length).toBe(closedLooks);
      stop();
      stopMcpProbes();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets a server that was only started vouch for Puppeteer's browser", async () => {
    installed.set('npx', '/usr/bin/npx');
    const calls: string[] = [];
    servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
      proc.stdin.write.mockImplementation((line: string) => {
        const { method } = JSON.parse(line);
        calls.push(method);
        if (method === 'tools/call') {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Failed to launch the browser process' } }) + '\n'));
        }
      });
      answer(proc);
    };
    // A custom server with the built-in Puppeteer's command: it is ready once it starts
    const settings = {
      customServers: [
        { id: 'my-puppeteer', name: 'My Puppeteer', type: 'command' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], verified: true },
      ],
    };
    getMcpAvailability(['my-puppeteer', 'puppeteer'], settings);
    await vi.waitFor(() => expect(getMcpAvailability(['my-puppeteer'], settings)['my-puppeteer'].state).toBe('ready'));
    // The built-in one gets its own probe, which asks for a browser
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], settings).puppeteer.state).toBe('unavailable'));
    expect(mocks.spawnTool).toHaveBeenCalledTimes(2);
    expect(calls).toContain('tools/call');
    stopMcpProbes();
  });
});
