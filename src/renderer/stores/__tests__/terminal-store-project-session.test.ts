/**
 * A Claude chat's session shown in an agent window (the chat's Clawd button): the window running it
 * already is shown, resumed there when back at its shell, else a new window resumes it as its own
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useTerminalStore } from '../terminal-store';

vi.mock('../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: { set: vi.fn(), clear: vi.fn(), get: vi.fn(), dispose: vi.fn() },
}));

const PROJECT = '/home/user/project';
const WINDOW = '8670dcb1-0000-0000-0000-000000000000';
const request = { projectPath: PROJECT, title: 'Release notes', sessionId: 'chat-session', profileId: 'main' };

beforeEach(() => {
  useTerminalStore.setState({ terminals: [], activeTerminalId: null, maxTerminals: 3, agentsViewRequest: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a chat's session in an agent window", () => {
  it('opens a new window resuming the session as its own when none runs it, and shows the Agents page', () => {
    const terminal = useTerminalStore.getState().openProjectSession(request);
    expect(terminal).toMatchObject({
      title: 'Release notes',
      launchCLIOnCreate: true,
      pendingTaskSession: { sessionId: 'chat-session', profileId: 'main', own: true },
    });
    expect(useTerminalStore.getState().agentsViewRequest).toMatchObject({ projectPath: PROJECT });
  });

  it('shows the window running it already instead of opening another', () => {
    useTerminalStore.getState().addTerminal(PROJECT, PROJECT, { id: WINDOW });
    useTerminalStore.getState().updateTerminal(WINDOW, { status: 'running', isCLIMode: true });
    const terminal = useTerminalStore.getState().openProjectSession({ ...request, terminalId: WINDOW });
    expect(terminal?.id).toBe(WINDOW);
    expect(useTerminalStore.getState().terminals).toHaveLength(1);
    expect(useTerminalStore.getState().activeTerminalId).toBe(WINDOW);
    expect(useTerminalStore.getState().agentsViewRequest).toMatchObject({ projectPath: PROJECT });
  });

  it('resumes the session in that window when it is back at its shell', () => {
    const resume = vi.fn();
    vi.stubGlobal('window', { electronAPI: { resumeTaskSessionInTerminal: resume } });
    useTerminalStore.getState().addTerminal(PROJECT, PROJECT, { id: WINDOW });
    useTerminalStore.getState().updateTerminal(WINDOW, { status: 'running', isCLIMode: false });
    const terminal = useTerminalStore.getState().openProjectSession({ ...request, terminalId: WINDOW });
    expect(resume).toHaveBeenCalledWith(WINDOW, { sessionId: 'chat-session', profileId: 'main', cwd: PROJECT, own: true });
    expect(terminal?.isCLIMode).toBe(true);
  });

  it('opens a new window when the one named has exited', () => {
    useTerminalStore.getState().addTerminal(PROJECT, PROJECT, { id: WINDOW });
    useTerminalStore.getState().updateTerminal(WINDOW, { status: 'exited' });
    const terminal = useTerminalStore.getState().openProjectSession({ ...request, terminalId: WINDOW });
    expect(terminal?.id).not.toBe(WINDOW);
  });
});
