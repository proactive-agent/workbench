/**
 * The agent window line about messaging the project's running tasks
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectKey } from '../../../shared/utils/task-messaging';

let settingsFile: Record<string, unknown> | undefined;
const dirs = vi.hoisted(() => ({ project: '', home: '', profile: '' }));

vi.mock('../../settings-utils', () => ({
  readSettingsFile: () => settingsFile,
}));
vi.mock('../../project-store', () => ({
  projectStore: {
    getProjects: () => [{ id: 'proj-1', path: dirs.project }],
  },
}));
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => ({ getProfileConfigDirs: () => [dirs.profile] }),
}));
vi.mock('../../platform/claude-home', () => ({
  joinClaudeHome: (...parts: string[]) => path.join(dirs.home, ...parts),
  expandClaudeHome: (p: string) => p,
}));

import { agentWindowMessagingHint } from '../window-hint';

let root: string;

beforeEach(() => {
  settingsFile = undefined;
  root = mkdtempSync(path.join(tmpdir(), 'window-hint-'));
  dirs.project = path.join(root, 'app');
  dirs.home = path.join(root, 'home');
  dirs.profile = path.join(root, 'profile');
  mkdirSync(dirs.project);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSettings(dir: string, content: string | Buffer) {
  mkdirSync(path.dirname(dir), { recursive: true });
  writeFileSync(dir, content);
}

describe('agentWindowMessagingHint', () => {
  it('is left out by default (the user opts in to messages from sessions)', () => {
    expect(agentWindowMessagingHint(dirs.project)).toBe('');
  });

  it("names the project's task sessions and how to reach them once the user opts in", () => {
    settingsFile = { claudeCodeTasks: { sessionMessages: true } };
    const hint = agentWindowMessagingHint(dirs.project);
    expect(hint).toContain(`wb-${projectKey('proj-1')}-`);
    expect(hint).toContain('SendMessage');
    expect(hint).toContain('ListAgents');
    // Typed inside the flag's quotes in every shell
    expect(hint).not.toMatch(/["'$`%!<>]/);
  });

  it('is left out for windows without a known project', () => {
    settingsFile = { claudeCodeTasks: { sessionMessages: true } };
    expect(agentWindowMessagingHint(undefined)).toBe('');
    expect(agentWindowMessagingHint(path.join(root, 'elsewhere'))).toBe('');
  });

  it('is left out when Task messaging is off, even with messages from sessions on', () => {
    settingsFile = { claudeCodeTasks: { taskMessaging: false, sessionMessages: true } };
    expect(agentWindowMessagingHint(dirs.project)).toBe('');
    settingsFile = { claudeCodeTasks: { taskMessaging: true, sessionMessages: false } };
    expect(agentWindowMessagingHint(dirs.project)).toBe('');
  });

  it('treats a stored value that is not a boolean as the default (off)', () => {
    settingsFile = { claudeCodeTasks: { sessionMessages: 'yes' } };
    expect(agentWindowMessagingHint(dirs.project)).toBe('');
  });

  it.each([
    ['the default config dir', () => path.join(dirs.home, '.claude', 'settings.json'), JSON.stringify({ crossSessionInbound: 'hold' })],
    ["an account's config dir", () => path.join(dirs.profile, 'settings.json'), JSON.stringify({ crossSessionInbound: 'refuse' })],
    ['the project', () => path.join(dirs.project, '.claude', 'settings.json'), JSON.stringify({ crossSessionInbound: 'refuse' })],
    ['the local project settings, in UTF-16', () => path.join(dirs.project, '.claude', 'settings.local.json'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ crossSessionInbound: 'hold' }), 'utf16le')])],
    ['a settings file that is not valid JSON', () => path.join(dirs.project, '.claude', 'settings.json'), '{ oops'],
  ])("is left out when the user's own settings hold or refuse messages (%s): runs won't accept them", (_where, file, content) => {
    settingsFile = { claudeCodeTasks: { sessionMessages: true } };
    writeSettings(file(), content);
    expect(agentWindowMessagingHint(dirs.project)).toBe('');
  });

  it("is given when the user's own settings accept messages", () => {
    settingsFile = { claudeCodeTasks: { sessionMessages: true } };
    writeSettings(path.join(dirs.home, '.claude', 'settings.json'), JSON.stringify({ crossSessionInbound: 'accept', model: 'opus' }));
    expect(agentWindowMessagingHint(dirs.project)).toContain('SendMessage');
  });
});
