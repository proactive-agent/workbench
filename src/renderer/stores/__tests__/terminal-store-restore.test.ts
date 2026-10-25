import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTerminalStore } from '../terminal-store';
import type { TerminalSession } from '../../../main/terminal-session-store';

vi.mock('../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: { set: vi.fn(), clear: vi.fn(), get: vi.fn() },
}));

const PROJECT = '/home/user/project';

const session = (id: string, isCLIMode = false): TerminalSession => ({
  id,
  title: `Terminal ${id}`,
  cwd: PROJECT,
  projectPath: PROJECT,
  isCLIMode,
  outputBuffer: 'what the window showed before',
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
});

beforeEach(() => {
  useTerminalStore.setState({ terminals: [], activeTerminalId: null, maxTerminals: 6 });
});

describe('a restored window', () => {
  it('shows a spinner while its shell starts', () => {
    useTerminalStore.getState().addRestoredTerminal(session('a'));
    expect(useTerminalStore.getState().terminals[0].loading).toBe('shell');
  });

  it('waits for Claude Code when its session resumes', () => {
    useTerminalStore.getState().addRestoredTerminal(session('b', true));
    expect(useTerminalStore.getState().terminals[0].loading).toBe('claude');
  });
});
