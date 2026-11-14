/**
 * @vitest-environment jsdom
 */
/**
 * A pasted session name is a recipient only when it is another chat or agent window of the project
 * and messaging is on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useInsightsStore } from '../../stores/insights-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { useSettingsStore } from '../../stores/settings-store';
import { sessionTarget, sessionTargetNow, windowSessionTitle } from '../session-targets';
import type { InsightsSessionSummary } from '../../../shared/types';

const chat = (id: string, title: string) => ({ id, title, projectId: 'p1', messageCount: 1, createdAt: new Date(), updatedAt: new Date() }) as InsightsSessionSummary;
const CHAT_ID = 'session-1794000000000';
const CHAT_NAME = `chat-${(1794000000000).toString(36)}`;

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, claudeCodeTasks: undefined } });
  useInsightsStore.setState({ projectId: 'p1', sessions: [chat(CHAT_ID, 'Release notes')] });
  useTerminalStore.setState({
    terminals: [
      { id: '1a25c6f1-0000-0000-0000-000000000000', title: 'Agent 1', projectPath: '/project' },
      { id: '2b36d702-0000-0000-0000-000000000000', title: 'Other', projectPath: '/other' },
    ] as never,
  });
});

describe('sessionTargetNow', () => {
  it("finds the project's chats and agent windows by name, with their titles", () => {
    expect(sessionTargetNow(CHAT_NAME, '/project')).toMatchObject({ kind: 'chat', name: CHAT_NAME, title: 'Release notes' });
    expect(sessionTargetNow(' agent-1a25c6f1 ', '/project')).toMatchObject({ kind: 'agent', hash: '1a25c6f1', title: 'Agent 1' });
  });

  it('is nothing for another project, an unknown name, the session itself or with messaging off', () => {
    expect(sessionTargetNow('agent-2b36d702', '/project')).toBeNull();
    expect(sessionTargetNow('chat-zzzzzz', '/project')).toBeNull();
    expect(sessionTargetNow(CHAT_NAME, '/project', CHAT_NAME)).toBeNull();
    expect(sessionTargetNow('hello', '/project')).toBeNull();
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, claudeCodeTasks: { sessionMessages: false } } });
    expect(sessionTargetNow(CHAT_NAME, '/project')).toBeNull();
  });
});

describe('sessionTarget', () => {
  it("asks for the project's chats when the Claude page hasn't loaded them", async () => {
    useInsightsStore.setState({ projectId: 'other', sessions: [] });
    const listInsightsSessions = vi.fn(async () => ({ success: true, data: [chat(CHAT_ID, 'Release notes')] }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { listInsightsSessions };
    await expect(sessionTarget(CHAT_NAME, { id: 'p1', path: '/project' })).resolves.toMatchObject({ title: 'Release notes' });
    expect(listInsightsSessions).toHaveBeenCalledWith('p1');
  });
});

describe('windowSessionTitle', () => {
  it("is the name of the session an agent window has open, as its Session menu shows it", async () => {
    const listClaudeSessions = vi.fn(async () => ({
      success: true,
      data: [
        { sessionId: 's1', name: 'Older session', modifiedAt: 2, current: false },
        { sessionId: 's2', name: 'Fix the CI', modifiedAt: 1, current: true },
      ],
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { listClaudeSessions };
    await expect(windowSessionTitle('/project', 'agent-1a25c6f1')).resolves.toBe('Fix the CI');
    expect(listClaudeSessions).toHaveBeenCalledWith('1a25c6f1-0000-0000-0000-000000000000');
    // Another project's window, or a window with no session open
    await expect(windowSessionTitle('/project', 'agent-2b36d702')).resolves.toBeUndefined();
    listClaudeSessions.mockResolvedValueOnce({ success: true, data: [] });
    await expect(windowSessionTitle('/project', 'agent-1a25c6f1')).resolves.toBeUndefined();
  });
});
