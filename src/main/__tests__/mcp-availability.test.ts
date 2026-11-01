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
vi.mock('../browser-profiles/in-use', () => ({ isBrowserProfileInUse: async () => mocks.browserOpen }));
vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn() } }));

let getMcpAvailability: typeof import('../mcp-availability').getMcpAvailability;
let onMcpAvailabilityChange: typeof import('../mcp-availability').onMcpAvailabilityChange;
let usableMcpConnectorIds: typeof import('../mcp-availability').usableMcpConnectorIds;
let resetMcpAvailability: typeof import('../mcp-availability').resetMcpAvailability;
let stopMcpProbes: typeof import('../mcp-availability').stopMcpProbes;
let UNAVAILABLE_RECHECK_MS: number;

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
    mocks.resolveCommand.mockImplementation(async (command: string) => installed.get(command) ?? null);
    mocks.spawnTool.mockImplementation((_tool: string, args: string[]) => {
      const proc = new FakeProcess();
      setTimeout(() => servers[args.join(' ')]?.(proc), 0);
      return proc;
    });
    vi.resetModules();
    ({
      getMcpAvailability, onMcpAvailabilityChange, usableMcpConnectorIds, resetMcpAvailability, stopMcpProbes, UNAVAILABLE_RECHECK_MS,
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
    expect(JSON.parse(env.PUPPETEER_LAUNCH_OPTIONS)).toEqual({ executablePath: '/opt/gone/chrome' });

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
});
