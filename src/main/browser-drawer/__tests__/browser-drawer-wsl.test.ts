/**
 * Temp folders in WSL mode (mocked runtime): chat browsers run on Windows (browser-runtime.ts), but
 * folders left in the distribution's own temp folder by earlier versions are still swept with the
 * system's
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

const root = mkdtempSync(path.join(os.tmpdir(), 'drawer-wsl-test-'));
const wsl = vi.hoisted(() => ({ home: '/home/me', distro: 'Ubuntu', mountRoot: '/mnt/' }));

vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  isWslRuntime: () => true,
  getWslInfo: () => wsl,
  getSessionWslInfo: () => wsl,
  runNatively: <T,>(fn: () => T) => fn(),
  getShellRuntimeStatus: () => ({ wsl: { version: 2 } }),
  // The distribution's folders under the test's folder (standing in for \\wsl.localhost\Ubuntu)
  toHostPath: (p: string) => path.join(root, 'wsl', p),
  toRuntimePath: (p: string) => p,
}));

import { runtimeTempParent, tempFolderParents } from '../../temp-folders';

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('temp folders in WSL mode', () => {
  it("sweeps the distribution's temp folder with the system's", async () => {
    const parent = await runtimeTempParent();
    expect(parent).toBe(path.join(root, 'wsl', '/home/me/.cache/workbench/tmp'));
    expect(existsSync(parent)).toBe(true);
    expect(await tempFolderParents()).toEqual([os.tmpdir(), parent]);
  });
});
