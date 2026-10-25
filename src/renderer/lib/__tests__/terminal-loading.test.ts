import { beforeEach, describe, expect, it } from 'vitest';
import { startTerminalLoading, stopTerminalLoading, terminalLoadingEnds } from '../terminal-loading';

const EXIT_MARKER = '\x1b]777;workbench-cli-exit\x07';
const TYPED = "$ cd '/repo' && 'claude' --session-id abc; printf '\\033]777;workbench-cli-exit\\007'\r\n";

describe('terminal loading', () => {
  beforeEach(() => {
    stopTerminalLoading('w');
  });

  it('ends a shell start at its first visible output', () => {
    startTerminalLoading('w', 'shell');
    expect(terminalLoadingEnds('w', '\x1b[?2004h')).toBe(false);
    expect(terminalLoadingEnds('w', 'me@host:~/repo$ ')).toBe(true);
    // No longer watched
    expect(terminalLoadingEnds('w', 'more')).toBe(false);
  });

  it('ends a Claude Code start once its interface shows after the typed command', () => {
    startTerminalLoading('w', 'claude');
    // The Claude Code that is closing redraws its footer before the anchor: not the new one
    expect(terminalLoadingEnds('w', '⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe(false);
    expect(terminalLoadingEnds('w', `Bye${EXIT_MARKER}`)).toBe(false);
    expect(terminalLoadingEnds('w', TYPED)).toBe(false);
    expect(terminalLoadingEnds('w', '\x1b[2m Claude Code v2.1.310\x1b[0m\r\n')).toBe(false);
    expect(terminalLoadingEnds('w', '⏵⏵ bypass permissions on (shift+')).toBe(false);
    // Split across chunks
    expect(terminalLoadingEnds('w', 'tab to cycle)')).toBe(true);
  });

  it('ends when Claude Code asks something, or exits at once', () => {
    startTerminalLoading('w', 'claude');
    terminalLoadingEnds('w', TYPED);
    expect(terminalLoadingEnds('w', 'Do you trust the files in this folder?')).toBe(true);

    startTerminalLoading('w', 'claude');
    terminalLoadingEnds('w', TYPED);
    expect(terminalLoadingEnds('w', `No conversation found${EXIT_MARKER}`)).toBe(true);
  });

  it('ends when the window shows a running task read-only, without a command', () => {
    startTerminalLoading('w', 'claude');
    expect(terminalLoadingEnds('w', "\x1b[2J\x1b[2mFollowing this task's Claude Code session (read-only).")).toBe(true);
  });
});
