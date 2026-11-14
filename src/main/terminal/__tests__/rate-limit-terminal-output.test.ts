/**
 * Terminal output only records a rate limit for a real Claude limit message, not for code,
 * diffs or chats that quote one (which used to flag a working account as rate limited until
 * "Dec 17", two months later).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TerminalProcess } from '../types';

const profileManager = vi.hoisted(() => ({
  recordRateLimitEvent: vi.fn(() => ({ type: 'session' })),
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, BrowserWindow: vi.fn() }));
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => profileManager,
  initializeClaudeProfileManager: vi.fn(),
}));
vi.mock('../../claude-profile/usage-monitor', () => ({ getUsageMonitor: vi.fn() }));
vi.mock('../../ipc-handlers/utils', () => ({ safeSendToRenderer: vi.fn() }));

import { handleRateLimit } from '../cli-integration-handler';

const ESC = '\u001b';

function terminal(): TerminalProcess {
  return { id: 'term-1', claudeProfileId: 'primary', outputBuffer: '', title: 'Terminal 1', cwd: '/tmp' } as unknown as TerminalProcess;
}

function feed(data: string): void {
  handleRateLimit(terminal(), data, new Map(), () => null);
}

describe('handleRateLimit (terminal output)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores a limit message quoted in syntax-highlighted source code', () => {
    feed(` * Matches: "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"${ESC}[38;2;248;248;242m\r\n`);
    feed(`${ESC}[32m+${ESC}[0m      const output = 'Limit reached · resets Dec 17 at 6am (Europe/Oslo)'${ESC}[39m${ESC}[K\r\n`);
    feed(`// Limit reached · resets 11:59pm\r\n`);

    expect(profileManager.recordRateLimitEvent).not.toHaveBeenCalled();
  });

  it('records a limit message Claude Code shows on its own line', () => {
    feed(`  ${ESC}[2m⎿${ESC}[22m  ${ESC}[31mLimit reached · resets 3pm (Europe/Oslo)${ESC}[39m\r\n`);

    expect(profileManager.recordRateLimitEvent).toHaveBeenCalledWith('primary', '3pm (Europe/Oslo)');
  });
});
