/**
 * The agent window line about messaging the project's running tasks
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectKey } from '../../../shared/utils/task-messaging';

let settingsFile: Record<string, unknown> | undefined;

vi.mock('../../settings-utils', () => ({
  readSettingsFile: () => settingsFile,
}));
vi.mock('../../project-store', () => ({
  projectStore: {
    getProjects: () => [{ id: 'proj-1', path: '/work/app' }],
  },
}));

import { agentWindowMessagingHint } from '../window-hint';

beforeEach(() => {
  settingsFile = undefined;
});

describe('agentWindowMessagingHint', () => {
  it("names the project's task sessions and how to reach them, by default", () => {
    const hint = agentWindowMessagingHint('/work/app');
    expect(hint).toContain(`wb-${projectKey('proj-1')}-`);
    expect(hint).toContain('SendMessage');
    expect(hint).toContain('ListAgents');
    // Typed inside the flag's quotes in every shell
    expect(hint).not.toMatch(/["'$`%!<>]/);
  });

  it('is left out for windows without a known project', () => {
    expect(agentWindowMessagingHint(undefined)).toBe('');
    expect(agentWindowMessagingHint('/elsewhere')).toBe('');
  });

  it('is left out when Task messaging or messages from sessions are off', () => {
    settingsFile = { claudeCodeTasks: { taskMessaging: false } };
    expect(agentWindowMessagingHint('/work/app')).toBe('');
    settingsFile = { claudeCodeTasks: { sessionMessages: false } };
    expect(agentWindowMessagingHint('/work/app')).toBe('');
  });

  it('treats a stored value that is not a boolean as the default (on)', () => {
    settingsFile = { claudeCodeTasks: { sessionMessages: 'yes' } };
    expect(agentWindowMessagingHint('/work/app')).toContain('SendMessage');
  });
});
