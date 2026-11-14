/**
 * The line an agent window's --append-system-prompt gets is typed inside the flag's quotes: a
 * quote, $, backtick, %, ! or angle bracket in it would break the command (an apostrophe ended the
 * single-quoted text, and the window's Claude Code never started).
 */
import { describe, it, expect } from 'vitest';
import { agentWindowSessionsHint } from '../window-hint';

describe('agentWindowSessionsHint', () => {
  it('names the window and holds nothing the shell would read', () => {
    const hint = agentWindowSessionsHint('0f5db44b-1111-2222-3333-444444444444');
    expect(hint).toContain('agent-0f5db44b');
    expect(hint).not.toMatch(/["'$`%!<>‘’“”]/);
  });
});
