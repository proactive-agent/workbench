import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlanFromConfigDir } from '../profile-utils';

const dirs: string[] = [];
function configDir(claudeJson?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-test-'));
  dirs.push(dir);
  if (claudeJson !== undefined) writeFileSync(join(dir, '.claude.json'), typeof claudeJson === 'string' ? claudeJson : JSON.stringify(claudeJson));
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('getPlanFromConfigDir', () => {
  it('reads the plan from oauthAccount.organizationType', () => {
    expect(getPlanFromConfigDir(configDir({ oauthAccount: { organizationType: 'claude_max' } }))).toBe('max');
    expect(getPlanFromConfigDir(configDir({ oauthAccount: { organizationType: 'claude_pro' } }))).toBe('pro');
  });

  it('ignores the stale credentials subscriptionType', () => {
    const dir = configDir({ oauthAccount: { organizationType: 'claude_max' } });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { subscriptionType: 'pro' } }));
    expect(getPlanFromConfigDir(dir)).toBe('max');
  });

  it('returns null when the plan is unknown', () => {
    expect(getPlanFromConfigDir(undefined)).toBeNull();
    expect(getPlanFromConfigDir(configDir())).toBeNull();
    expect(getPlanFromConfigDir(configDir({}))).toBeNull();
    expect(getPlanFromConfigDir(configDir({ oauthAccount: { organizationType: 'api' } }))).toBeNull();
    expect(getPlanFromConfigDir(configDir('not json'))).toBeNull();
  });
});
