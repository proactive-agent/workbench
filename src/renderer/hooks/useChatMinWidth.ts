/**
 * The Claude chat's narrowest width: what its composer's tool row needs (lib/composer-fit.ts),
 * measured when a chat opens and when its composer changes (`composerKey`: a new chat's or a
 * conversation's, another model's label), the interface font changes or a font finishes loading,
 * then kept in the browser drawer store, where the drawer's widest width and the sidebars'
 * auto-closing (useChatRoom) read it.
 */
import { useLayoutEffect, type RefObject } from 'react';
import { chatWidthForRow } from '../lib/composer-fit';
import { useBrowserDrawerStore } from '../stores/browser-drawer-store';
import { useSettingsStore } from '../stores/settings-store';

export function useChatMinWidth(row: HTMLElement | null, columnRef: RefObject<HTMLElement | null>, composerKey: string): void {
  const interfaceFont = useSettingsStore((state) => state.settings.interfaceFont);

  useLayoutEffect(() => {
    const column = columnRef.current;
    if (!row || !column) return;
    const measure = () => {
      if (row.isConnected) useBrowserDrawerStore.getState().setChatMinWidth(chatWidthForRow(row, column));
    };
    measure();
    // A font that loads later (the interface font switched in Settings, applied by the app after
    // this page renders) changes the buttons' widths
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [row, columnRef, composerKey, interfaceFont]);
}
