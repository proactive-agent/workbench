/**
 * Claude Code inside WSL has accounts of its own (in the Linux home), kept in a profile store of
 * their own (claude-profiles.wsl.json): switching between native and WSL keeps each side's
 * accounts, names, active account and usage instead of dropping or remapping them. Nothing is
 * saved before the store of this session's runtime is chosen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DetectedSetup } from '../claude-profile/claude-code-detection';

const userDataRef = vi.hoisted(() => ({ dir: '' }));
const setupsRef = vi.hoisted(() => ({ native: [] as DetectedSetup[], wsl: [] as DetectedSetup[] }));
const wslRef = vi.hoisted(() => ({ on: false, ready: Promise.resolve() as Promise<unknown> }));

vi.mock('electron', () => ({
  app: { getPath: () => userDataRef.dir },
}));
vi.mock('../claude-profile/credential-utils', () => ({
  getCredentialsFromKeychain: vi.fn(() => ({ token: null, email: null })),
  normalizeWindowsPath: (p: string) => p,
  updateProfileSubscriptionMetadata: vi.fn(() => ({})),
}));
vi.mock('../claude-profile/claude-code-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude-profile/claude-code-detection')>();
  return { ...actual, detectClaudeCodeSetups: () => (wslRef.on ? setupsRef.wsl : setupsRef.native) };
});
vi.mock('../platform/shell-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/shell-runtime')>()),
  whenShellRuntimeReady: () => wslRef.ready,
  isWslRuntime: () => wslRef.on,
  getWslInfo: () => (wslRef.on ? { distro: 'Ubuntu', home: '/home/me', mountRoot: '/mnt/', loginPath: '/usr/bin', tools: {} } : null),
}));

import { ClaudeProfileManager, getProfileStoreFileName } from '../claude-profile-manager';

let root: string;
const store = (name: string) => join(userDataRef.dir, 'config', name);

const bedrock = (configDir: string): DetectedSetup => ({
  configDir,
  provider: 'bedrock',
  isDefaultDir: false,
  values: [{ key: 'CLAUDE_CODE_USE_BEDROCK', value: '1', source: 'settings.json' }],
});

async function start(): Promise<ClaudeProfileManager> {
  const manager = new ClaudeProfileManager();
  await manager.initialize();
  return manager;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profile-runtime-'));
  userDataRef.dir = join(root, 'userData');
  mkdirSync(join(userDataRef.dir, 'config'), { recursive: true });
  wslRef.on = false;
  wslRef.ready = Promise.resolve();
  setupsRef.native = [bedrock(join(root, 'home', '.claude-work'))];
  setupsRef.wsl = [bedrock('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude-linux')];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('profile store per runtime', () => {
  it('names a store file per runtime', () => {
    expect(getProfileStoreFileName(false)).toBe('claude-profiles.json');
    expect(getProfileStoreFileName(true)).toBe('claude-profiles.wsl.json');
  });

  it("keeps native and WSL accounts apart, so a switch doesn't drop or rename either side's", async () => {
    const native = await start();
    const nativeAccount = native.getSettings().profiles.find((p) => p.detected)!;
    native.renameProfile(nativeAccount.id, 'Windows work');
    expect(existsSync(store('claude-profiles.json'))).toBe(true);
    expect(existsSync(store('claude-profiles.wsl.json'))).toBe(false);

    wslRef.on = true;
    const wsl = await start();
    const wslAccounts = wsl.getSettings().profiles;
    expect(wslAccounts.map((p) => p.configDir)).toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude-linux']);
    wsl.renameProfile(wslAccounts[0].id, 'Linux work');
    expect(JSON.parse(readFileSync(store('claude-profiles.wsl.json'), 'utf-8')).profiles[0].name).toBe('Linux work');

    // Back to native: the native account is as it was
    wslRef.on = false;
    const again = await start();
    const back = again.getSettings().profiles.find((p) => p.detected)!;
    expect(back).toMatchObject({ id: nativeAccount.id, name: 'Windows work', configDir: nativeAccount.configDir });
    expect(JSON.parse(readFileSync(store('claude-profiles.wsl.json'), 'utf-8')).profiles[0].name).toBe('Linux work');
  });

  it("saves nothing before the runtime's store is chosen", async () => {
    let finishDetection: () => void = () => undefined;
    wslRef.on = true;
    wslRef.ready = new Promise<void>((resolve) => { finishDetection = resolve; });

    const manager = new ClaudeProfileManager();
    const initializing = manager.initialize();
    manager.renameProfile('primary', 'Renamed');
    expect(existsSync(store('claude-profiles.json'))).toBe(false);

    finishDetection();
    await initializing;
    expect(existsSync(store('claude-profiles.json'))).toBe(false);
    expect(existsSync(store('claude-profiles.wsl.json'))).toBe(true);
  });
});
