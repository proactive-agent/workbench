import { useEffect, useRef } from 'react';
import { useBrowserDrawerStore } from '../stores/browser-drawer-store';
import type { BrowserDrawerState } from '../../shared/types/browser-drawer';

/**
 * Keep the browser drawer's store in step with the main process: the live Playwright sessions and
 * the dashboard's URL. A session of the window's project that starts opens the drawer on it
 */
export function useBrowserDrawerSync(projectId: string | null | undefined): void {
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  useEffect(() => {
    let cancelled = false;
    const receive = (state: BrowserDrawerState) => useBrowserDrawerStore.getState().receiveState(state, projectRef.current);
    const cleanup = window.electronAPI.onBrowserDrawerState(receive);
    void window.electronAPI.getBrowserDrawerState().then((result) => {
      // A state sent meanwhile is newer
      if (!cancelled && result.success && result.data && !useBrowserDrawerStore.getState().loaded) receive(result.data);
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);
}
