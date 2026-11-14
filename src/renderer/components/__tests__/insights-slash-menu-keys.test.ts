/**
 * @vitest-environment jsdom
 */
/**
 * The `/` menu's keys: Enter on a command typed out in full sends it, Shift+Tab and keys of an
 * input method stay theirs, and a failed list is asked again when the menu opens again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { useSlashCommandMenu } from '../insights-slash-commands';

const listInsightsCommands = vi.fn();

beforeEach(() => {
  listInsightsCommands.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { listInsightsCommands };
});

const key = (k: string, extra: { shiftKey?: boolean; isComposing?: boolean } = {}) => ({
  key: k,
  shiftKey: extra.shiftKey ?? false,
  nativeEvent: { isComposing: extra.isComposing ?? false },
  preventDefault: vi.fn(),
}) as unknown as KeyboardEvent;

let account = 0;
function render(value: string, onInsert = vi.fn()) {
  // Each test its own account, so the cached lists don't carry over
  const accountKey = `account-${++account}`;
  return renderHook(
    (props: { value: string }) => useSlashCommandMenu({ projectId: 'p', accountKey, enabled: true, value: props.value, caret: props.value.length, onInsert }),
    { initialProps: { value } }
  );
}

describe('useSlashCommandMenu keys', () => {
  it('lets Enter send a command typed out in full, and picks with Enter on a partial one', async () => {
    listInsightsCommands.mockResolvedValue({ success: true, data: [{ name: 'review', description: '' }, { name: 'review-pr', description: '' }] });
    const onInsert = vi.fn();
    const { result, rerender } = render('/review', onInsert);
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.handleKeyDown(key('Enter'))).toBe(false);

    rerender({ value: '/rev' });
    let handled = false;
    act(() => {
      handled = result.current.handleKeyDown(key('Enter'));
    });
    expect(handled).toBe(true);
    expect(onInsert).toHaveBeenCalledWith('/review ', 8);
  });

  it('leaves Shift+Tab and an input method\'s keys alone', async () => {
    listInsightsCommands.mockResolvedValue({ success: true, data: [{ name: 'design', description: '' }, { name: 'debug', description: '' }] });
    const { result } = render('/de');
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.handleKeyDown(key('Tab', { shiftKey: true }))).toBe(false);
    expect(result.current.handleKeyDown(key('Enter', { isComposing: true }))).toBe(false);
    expect(result.current.handleKeyDown(key('ArrowDown', { isComposing: true }))).toBe(false);
  });

  it('shows a failure, then asks again when the menu opens again', async () => {
    listInsightsCommands.mockResolvedValueOnce({ success: false, error: 'timeout' });
    const { result, rerender } = render('/');
    await waitFor(() => expect(result.current.error).toBe('timeout'));
    expect(result.current.open).toBe(true);

    listInsightsCommands.mockResolvedValueOnce({ success: true, data: [{ name: 'review', description: '' }] });
    rerender({ value: '' });
    rerender({ value: '/' });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(listInsightsCommands).toHaveBeenCalledTimes(2);
  });
});
