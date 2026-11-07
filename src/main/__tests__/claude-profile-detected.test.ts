/**
 * Accounts found in Claude Code's configuration, synced on every start:
 * - each setup becomes an account (usable, renamable; deleted on purpose unless it's in use)
 * - accounts added the old way leave the list once a setup is detected
 * - a later start updates its values and keeps its name; a setup that's gone drops its account
 * - a cloud provider setup counts as signed in (Claude Code authenticates it)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DetectedSetup } from '../claude-profile/claude-code-detection';

const userDataRef = vi.hoisted(() => ({ dir: '' }));
const setupsRef = vi.hoisted(() => ({ setups: [] as DetectedSetup[] }));

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
  return { ...actual, detectClaudeCodeSetups: () => setupsRef.setups };
});

import { ClaudeProfileManager } from '../claude-profile-manager';

let root: string;

const bedrock = (configDir: string, region: string): DetectedSetup => ({
  configDir,
  provider: 'bedrock',
  isDefaultDir: false,
  values: [
    { key: 'CLAUDE_CODE_USE_BEDROCK', value: '1', source: join(configDir, 'settings.json') },
    { key: 'AWS_REGION', value: region, source: join(configDir, 'settings.json') },
  ],
});

async function start(): Promise<ClaudeProfileManager> {
  const manager = new ClaudeProfileManager();
  await manager.initialize();
  return manager;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profile-detected-'));
  userDataRef.dir = join(root, 'userData');
  mkdirSync(join(userDataRef.dir, 'config'), { recursive: true });
  setupsRef.setups = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('accounts found in Claude Code configuration', () => {
  it('lists each setup as an account that can be used and renamed but not removed', async () => {
    const workDir = join(root, 'home', '.claude-work');
    mkdirSync(workDir, { recursive: true });
    setupsRef.setups = [bedrock(workDir, 'us-east-1')];

    const manager = await start();
    const account = manager.getSettings().profiles.find((profile) => profile.detected);
    expect(account).toMatchObject({ name: 'Claude Code (work)', configDir: workDir, isDefault: true, detected: { provider: 'bedrock' } });

    // Claude Code authenticates a cloud provider: usable like a signed-in account
    expect(manager.hasValidAuth(account!.id)).toBe(true);
    expect(manager.setActiveProfile(account!.id)).toBe(true);
    expect(manager.deleteProfile(account!.id)).toBe(false);
    expect(manager.renameProfile(account!.id, 'AWS work')).toBe(true);

    // The next start keeps its name and id, with the current values
    setupsRef.setups = [bedrock(workDir, 'eu-west-1')];
    const restarted = await start();
    const again = restarted.getSettings().profiles.find((profile) => profile.detected);
    expect(again).toMatchObject({ id: account!.id, name: 'AWS work' });
    expect(again?.detected?.values.find((value) => value.key === 'AWS_REGION')?.value).toBe('eu-west-1');
  });

  it('keeps only the detected setups, and drops an account whose setup is gone', async () => {
    const workDir = join(root, 'home', '.claude-work');
    mkdirSync(workDir, { recursive: true });
    setupsRef.setups = [bedrock(workDir, 'us-east-1')];
    const first = await start();
    // The default account added the old way leaves the list
    expect(first.getSettings().profiles.map((profile) => profile.name)).toEqual(['Claude Code (work)']);
    expect(first.getSettings().activeProfileId).toBe('claude-code-work');

    setupsRef.setups = [];
    const restarted = await start();
    const profiles = restarted.getSettings().profiles;
    // With no setup left, the default account comes back until a sign-in adds one
    expect(profiles.some((profile) => profile.detected)).toBe(false);
    expect(profiles.map((profile) => profile.name)).toEqual(['Primary']);
  });

  it('deletes an account only when it is not the one in use nor the only one, and moves references off it', async () => {
    const workDir = join(root, 'home', '.claude-work');
    const awsDir = join(root, 'home', '.claude-aws');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(awsDir, { recursive: true });
    setupsRef.setups = [bedrock(workDir, 'us-east-1'), bedrock(awsDir, 'eu-west-1')];

    const manager = await start();
    const [work, aws] = manager.getSettings().profiles;
    expect(manager.setActiveProfile(aws.id)).toBe(true);

    // The account in use can't be deleted
    expect(manager.detectedAccountDeletionBlocker(aws.id)).toMatch(/in use/);
    expect(manager.detectedAccountDeletionBlocker(work.id)).toBeNull();

    // Its files gone (account-deletion.ts), it leaves the accounts
    setupsRef.setups = [bedrock(awsDir, 'eu-west-1')];
    manager.removeDetectedAccount(work.id);
    expect(manager.getSettings().profiles.map((profile) => profile.id)).toEqual([aws.id]);
    expect(manager.getSettings().activeProfileId).toBe(aws.id);
    expect(manager.redetectAccounts().profiles.map((profile) => profile.id)).toEqual([aws.id]);

    // The only account left can't be deleted
    expect(manager.detectedAccountDeletionBlocker(aws.id)).not.toBeNull();
  });
});
