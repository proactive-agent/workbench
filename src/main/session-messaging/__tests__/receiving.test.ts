import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptsWindowInput,
  holdForChatReply,
  isReceiving,
  noteCursorQuery,
  receivingBusyChanged,
  releaseChatReply,
  releaseWindow,
  setReceivingHooks,
  startReceiving,
  stopReceiving,
} from '../receiving';

const from = { kind: 'chat' as const, name: 'chat-abc', title: 'Release notes' };
const notify = vi.fn();
let busy = false;

describe('agent window answering a message', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    notify.mockReset();
    busy = false;
    setReceivingHooks({ notify, isBusy: () => busy });
  });

  afterEach(() => {
    releaseWindow('window-1');
    vi.useRealTimers();
  });

  it('is read-only until its Claude Code has worked on the message and gone idle', () => {
    startReceiving('window-1', from);
    expect(isReceiving('window-1')).toBe(true);
    expect(notify).toHaveBeenLastCalledWith('window-1', from);

    receivingBusyChanged('window-1', true);
    vi.advanceTimersByTime(60_000);
    expect(isReceiving('window-1')).toBe(true);

    receivingBusyChanged('window-1', false);
    vi.advanceTimersByTime(2000);
    // Idle for a moment only: the message may start right after the turn that was running
    receivingBusyChanged('window-1', true);
    vi.advanceTimersByTime(5000);
    expect(isReceiving('window-1')).toBe(true);

    receivingBusyChanged('window-1', false);
    vi.advanceTimersByTime(3000);
    expect(isReceiving('window-1')).toBe(false);
    expect(notify).toHaveBeenLastCalledWith('window-1', null);
  });

  it('gives the window back when its Claude Code never starts working', () => {
    startReceiving('window-1', from);
    vi.advanceTimersByTime(30_000);
    expect(isReceiving('window-1')).toBe(false);
  });

  it('counts a window already working as having started', () => {
    busy = true;
    startReceiving('window-1', from);
    vi.advanceTimersByTime(60_000);
    expect(isReceiving('window-1')).toBe(true);
    receivingBusyChanged('window-1', false);
    vi.advanceTimersByTime(3000);
    expect(isReceiving('window-1')).toBe(false);
  });

  it('is given back once claude agents reports the session idle, when the output missed it', async () => {
    let status = 'busy';
    setReceivingHooks({ notify, isBusy: () => false, status: async () => status });
    startReceiving('window-1', from);
    await vi.advanceTimersByTimeAsync(4000);
    expect(isReceiving('window-1')).toBe(true);
    status = 'idle';
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(isReceiving('window-1')).toBe(false);
  });

  it("ignores the user's keys while read-only, but lets the terminal's own replies through", () => {
    expect(acceptsWindowInput('window-1', 'x')).toBe(true);
    startReceiving('window-1', from);
    expect(acceptsWindowInput('window-1', 'x')).toBe(false);
    expect(acceptsWindowInput('window-1', '\r')).toBe(false);
    expect(acceptsWindowInput('window-1', '\x1b[<0;10;5M')).toBe(false);
    // Focus, device attributes, mode, keyboard and window reports, OSC colors
    for (const reply of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[?2026;2$y', '\x1b[?0u', '\x1b[8;40;120t', '\x1b]11;rgb:1a1a/1a1a/1a1a\x1b\\']) {
      expect(acceptsWindowInput('window-1', reply)).toBe(true);
    }
  });

  it('lets a cursor report through only right after the program asked for one (Shift+F3 looks the same)', () => {
    startReceiving('window-1', from);
    expect(acceptsWindowInput('window-1', '\x1b[1;2R')).toBe(false);
    noteCursorQuery('window-1');
    expect(acceptsWindowInput('window-1', '\x1b[12;40R')).toBe(true);
    // One report per question
    expect(acceptsWindowInput('window-1', '\x1b[12;40R')).toBe(false);
    noteCursorQuery('window-1');
    vi.advanceTimersByTime(3000);
    expect(acceptsWindowInput('window-1', '\x1b[12;40R')).toBe(false);
  });

  it('is given back at once when taken over', () => {
    startReceiving('window-1', from);
    stopReceiving('window-1');
    expect(isReceiving('window-1')).toBe(false);
    expect(notify).toHaveBeenLastCalledWith('window-1', null);
  });

  it("is read-only while a chat replies in the session it runs too, until the reply ends", () => {
    const hold = holdForChatReply('window-1', from);
    expect(notify).toHaveBeenLastCalledWith('window-1', { ...from, sharing: true });
    expect(acceptsWindowInput('window-1', 'a')).toBe(false);
    // Nothing of the busy and idle timing applies: only the reply's end gives it back
    vi.advanceTimersByTime(60 * 60_000);
    expect(acceptsWindowInput('window-1', 'a')).toBe(false);
    expect(releaseChatReply('window-1', hold)).toBe(false);
    expect(acceptsWindowInput('window-1', 'a')).toBe(true);
    expect(notify).toHaveBeenLastCalledWith('window-1', null);
  });

  it('stays read-only while a reply that started as another ended still holds it', () => {
    const first = holdForChatReply('window-1', from);
    const second = holdForChatReply('window-1', { ...from, title: 'Second' });
    expect(releaseChatReply('window-1', first)).toBe(true);
    expect(acceptsWindowInput('window-1', 'a')).toBe(false);
    // Releasing the first twice changes nothing
    expect(releaseChatReply('window-1', first)).toBe(true);
    expect(releaseChatReply('window-1', second)).toBe(false);
    expect(acceptsWindowInput('window-1', 'a')).toBe(true);
  });

  it("keeps a chat's hold when its Claude Code exits (the window resuming the session goes through an exit)", () => {
    holdForChatReply('window-1', from);
    startReceiving('window-1', { kind: 'agent', name: 'agent-other' });
    stopReceiving('window-1');
    expect(acceptsWindowInput('window-1', 'a')).toBe(false);
  });

  it('stays read-only for the chat replying when a message it answered is done, and is given back by Take over', () => {
    holdForChatReply('window-1', from);
    startReceiving('window-1', { kind: 'agent', name: 'agent-other' });
    stopReceiving('window-1');
    expect(acceptsWindowInput('window-1', 'a')).toBe(false);
    expect(notify).toHaveBeenLastCalledWith('window-1', { ...from, sharing: true });

    releaseWindow('window-1');
    expect(acceptsWindowInput('window-1', 'a')).toBe(true);
    expect(notify).toHaveBeenLastCalledWith('window-1', null);
  });
});
