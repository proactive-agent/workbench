import { useEffect, useRef } from 'react';
import { useBrowserDrawerStore } from '../stores/browser-drawer-store';
import type { BrowserDrawerState } from '../../shared/types/browser-drawer';

/**
 * Keep the browser drawer's store in step with the main process: the live Playwright sessions and
 * the dashboard's URL. A session of the window's project that starts opens the drawer on it, and
 * the chat browsers' pages get Workbench's theme
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

  // The chat browsers' pages follow Workbench's theme (the `dark` class on <html>), on every page:
  // a chat's browser keeps running (and the agent keeps using it) while the drawer isn't shown
  useEffect(() => {
    const send = () => window.electronAPI.setBrowserColorScheme?.(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    send();
    const observer = new MutationObserver(send);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
}
