/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBrowserDrawerSync } from '../useBrowserDrawerSync';

describe('useBrowserDrawerSync', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it("gives the chat browsers Workbench's theme on every page, also when it changes", async () => {
    const api = {
      onBrowserDrawerState: vi.fn(() => () => {}),
      getBrowserDrawerState: vi.fn(async () => ({ success: false })),
      setBrowserColorScheme: vi.fn(),
    };
    (window as unknown as { electronAPI: typeof api }).electronAPI = api;
    document.documentElement.classList.add('dark');
    const { unmount } = renderHook(() => useBrowserDrawerSync('app'));
    expect(api.setBrowserColorScheme).toHaveBeenLastCalledWith('dark');
    document.documentElement.classList.remove('dark');
    await vi.waitFor(() => expect(api.setBrowserColorScheme).toHaveBeenLastCalledWith('light'));
    unmount();
  });
});
