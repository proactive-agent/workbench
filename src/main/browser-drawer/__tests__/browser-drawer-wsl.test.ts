/**
 * The browser drawer in WSL mode (mocked runtime): the bridge runs with the distribution's node,
 * the registry is the distribution's (through \\wsl.localhost) and asked through the bridge, and
 * chat browsers' folders are made in the distribution
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

const root = mkdtempSync(path.join(os.tmpdir(), 'drawer-wsl-test-'));
const wsl = vi.hoisted(() => ({ home: '/home/me', distro: 'Ubuntu', mountRoot: '/mnt/' }));
const spawned = vi.hoisted(() => [] as Array<{ tool: string; args: string[]; options: Record<string, unknown> }>);

vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  isWslRuntime: () => true,
  getWslInfo: () => wsl,
  getShellRuntimeStatus: () => ({ wsl: { version: 2 } }),
  // The distribution's folders under the test's folder (standing in for \\wsl.localhost\Ubuntu)
  toHostPath: (p: string) => path.join(root, 'wsl', p),
  toRuntimePath: (p: string) => p,
}));
vi.mock('../../mcp-commands', () => ({
  resolveCommand: async (command: string) => (command === 'node' ? '/usr/bin/node' : null),
}));
vi.mock('../../platform/runtime-exec', () => ({
  spawnTool: (tool: string, args: string[], options: Record<string, unknown>) => {
    spawned.push({ tool, args, options });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kill: () => true,
    });
    return child;
  },
  killRuntimeProcess: () => undefined,
  killRuntimeProcessTree: () => undefined,
}));

import { BrowserBridgeProcess } from '../bridge-process';
import { BrowserDrawerService } from '../browser-drawer-service';
import { registryAccess, setRegistryAccess } from '../registry';
import { runtimeTempParent, tempFolderParents } from '../../temp-folders';

afterEach(() => {
  setRegistryAccess(null);
  spawned.length = 0;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('browser drawer in WSL mode', () => {
  it("runs the bridge with the distribution's node, without Electron's variables", async () => {
    const bridge = new BrowserBridgeProcess({ scriptPath: path.join(root, 'browser-bridge.cjs') });
    await bridge.start();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].tool).toBe('node');
    expect(spawned[0].args).toEqual([path.join(root, 'browser-bridge.cjs')]);
    expect(spawned[0].options.command).toBe('/usr/bin/node');
    expect(spawned[0].options.env).toBeUndefined();
    expect(spawned[0].options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    bridge.killNow();
  });

  it("reads the distribution's registry and asks the bridge which browsers answer", async () => {
    const probes: string[][] = [];
    const bridge = Object.assign(new EventEmitter(), {
      running: false,
      start: async () => undefined,
      stop: async () => undefined,
      killNow: () => undefined,
      send: () => undefined,
      probe: async (endpoints: string[]) => {
        probes.push(endpoints);
        return new Set(endpoints.filter((e) => e.includes('live')));
      },
    });
    const service = new BrowserDrawerService({ getProjects: () => [], bridge: bridge as unknown as BrowserBridgeProcess });
    await service.start();
    const access = registryAccess('windows');
    expect(access.dir).toBe(path.join(root, 'wsl', '/home/me/.cache/ms-playwright/b'));
    expect(await access.connect('/tmp/pw-1/browser/live.sock')).toBe(true);
    expect(await access.connect('/tmp/pw-1/browser/closed.sock')).toBe(false);
    expect(probes).toEqual([['/tmp/pw-1/browser/live.sock'], ['/tmp/pw-1/browser/closed.sock']]);
    await service.shutdown();
  });

  it("makes chat browsers' folders in the distribution, and sweeps both temp folders", async () => {
    const parent = await runtimeTempParent();
    expect(parent).toBe(path.join(root, 'wsl', '/home/me/.cache/workbench/tmp'));
    expect(existsSync(parent)).toBe(true);
    expect(await tempFolderParents()).toEqual([os.tmpdir(), parent]);
  });
});
