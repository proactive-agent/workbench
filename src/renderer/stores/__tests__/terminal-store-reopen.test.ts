/**
 * A chat messages an agent window that isn't running: a closed one opens again under its own id,
 * and one restored at startup but not started yet (the Agents page wasn't shown) starts in the
 * background. Neither takes the user to the Agents page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useTerminalStore } from '../terminal-store';

vi.mock('../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: { set: vi.fn(), clear: vi.fn(), get: vi.fn(), dispose: vi.fn() },
}));

const PROJECT = '/home/user/project';
const request = { projectPath: PROJECT, terminalId: '1a19c850-0000-0000-0000-000000000000', title: 'Failing CI', sessionId: 'session-a' };

beforeEach(() => {
  useTerminalStore.setState({ terminals: [], activeTerminalId: null, maxTerminals: 3, agentsViewRequest: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('opening an agent window again for a message', () => {
  it('opens a closed window under its own id, resuming its last session, in the background', () => {
    const terminal = useTerminalStore.getState().reopenAgentWindow(request);
    expect(terminal).toMatchObject({
      id: request.terminalId,
      title: 'Failing CI',
      openedInBackground: true,
      launchCLIOnCreate: true,
      pendingTaskSession: { sessionId: 'session-a' },
    });
    expect(useTerminalStore.getState().agentsViewRequest).toBeNull();
  });

  it('opens a window whose session ran in a worktree in that worktree', () => {
    const worktree = `${PROJECT}/.workbench/worktrees/tasks/001-fix`;
    const terminal = useTerminalStore.getState().reopenAgentWindow({ ...request, cwd: worktree });
    expect(terminal).toMatchObject({ cwd: worktree, projectPath: PROJECT });
  });

  it('starts a window restored at startup in the background on the session, instead of adding another', () => {
    useTerminalStore.getState().addTerminal(PROJECT, PROJECT, { id: request.terminalId });
    useTerminalStore.getState().updateTerminal(request.terminalId, { pendingCLIResume: true });
    const terminal = useTerminalStore.getState().reopenAgentWindow(request);
    expect(useTerminalStore.getState().terminals).toHaveLength(1);
    expect(terminal).toMatchObject({
      openedInBackground: true,
      launchCLIOnCreate: true,
      pendingCLIResume: false,
      pendingTaskSession: { sessionId: 'session-a' },
    });
  });

  it('resumes the session in a window back at its shell', () => {
    const resume = vi.fn();
    vi.stubGlobal('window', { electronAPI: { resumeTaskSessionInTerminal: resume } });
    useTerminalStore.getState().addTerminal(PROJECT, PROJECT, { id: request.terminalId });
    useTerminalStore.getState().updateTerminal(request.terminalId, { status: 'running', isCLIMode: false });
    const terminal = useTerminalStore.getState().reopenAgentWindow(request);
    expect(resume).toHaveBeenCalledWith(request.terminalId, { sessionId: 'session-a', configDir: undefined, cwd: PROJECT });
    expect(terminal?.isCLIMode).toBe(true);
  });

  it("opens a window whose shell exited again, as a closed one", () => {
    vi.useFakeTimers();
    useTerminalStore.getState().addTerminal(PROJECT, PROJECT, { id: request.terminalId });
    useTerminalStore.getState().updateTerminal(request.terminalId, { status: 'exited' });
    expect(useTerminalStore.getState().reopenAgentWindow(request)).toBeNull();
    expect(useTerminalStore.getState().terminals).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(useTerminalStore.getState().terminals[0]).toMatchObject({ id: request.terminalId, status: 'idle', launchCLIOnCreate: true });
  });
});
