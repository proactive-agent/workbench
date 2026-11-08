/**
 * A chat messages an agent window that isn't running: a closed one opens again under its own id,
 * and one restored at startup but not started yet (the Agents page wasn't shown) starts in the
 * background. Neither takes the user to the Agents page.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTerminalStore } from '../terminal-store';

vi.mock('../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: { set: vi.fn(), clear: vi.fn(), get: vi.fn() },
}));

const PROJECT = '/home/user/project';
const request = { projectPath: PROJECT, terminalId: '1a19c850-0000-0000-0000-000000000000', title: 'Failing CI', sessionId: 'session-a' };

beforeEach(() => {
  useTerminalStore.setState({ terminals: [], activeTerminalId: null, maxTerminals: 3, agentsViewRequest: null });
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

  it('starts a window restored at startup in the background instead of adding another', () => {
    useTerminalStore.getState().addTerminal(PROJECT, PROJECT, { id: request.terminalId });
    const terminal = useTerminalStore.getState().reopenAgentWindow(request);
    expect(useTerminalStore.getState().terminals).toHaveLength(1);
    expect(terminal?.openedInBackground).toBe(true);
  });
});
