/**
 * A window shown again at the size its PTY already has (the Agents page after the Projects page)
 * still makes Claude Code redraw: the PTY is one column narrower for a moment, long enough for the
 * program to see that size, then gets its size back (two resizes in a row reach Node as one)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalProcess } from '../types';

vi.mock('@lydell/node-pty', () => ({ spawn: vi.fn() }));

import { resizePty } from '../pty-manager';

function terminal(cols: number, rows: number) {
  const sizes: Array<[number, number]> = [];
  const pty = {
    cols,
    rows,
    resize(c: number, r: number) {
      pty.cols = c;
      pty.rows = r;
      sizes.push([c, r]);
    },
  };
  return { sizes, process: { id: 'w', pty, hasExited: false } as unknown as TerminalProcess };
}

describe('resizePty', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resizes straight to a new size', () => {
    const { sizes, process } = terminal(80, 24);
    expect(resizePty(process, 120, 30)).toBe(true);
    expect(sizes).toEqual([[120, 30]]);
  });

  it('gives the same size back only after the program saw a narrower one', () => {
    const { sizes, process } = terminal(80, 24);
    resizePty(process, 80, 24);
    expect(sizes).toEqual([[79, 24]]);
    vi.advanceTimersByTime(300);
    expect(sizes).toEqual([[79, 24], [80, 24]]);
  });

  it('drops the size it was about to give back when a newer one comes, or the program exited', () => {
    const { sizes, process } = terminal(80, 24);
    resizePty(process, 80, 24);
    resizePty(process, 100, 24);
    vi.advanceTimersByTime(300);
    expect(sizes).toEqual([[79, 24], [100, 24]]);

    const exiting = terminal(80, 24);
    resizePty(exiting.process, 80, 24);
    exiting.process.hasExited = true;
    vi.advanceTimersByTime(300);
    expect(exiting.sizes).toEqual([[79, 24]]);
  });
});
