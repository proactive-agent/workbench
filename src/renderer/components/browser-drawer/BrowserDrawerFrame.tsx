/**
 * The browser drawer's box at its width: the only part that renders again while the drawer's edge
 * is dragged (the drawer's content is passed in, so it stays as it was)
 */
import { useEffect, useState, type ReactNode } from 'react';
import { clampDrawerWidth, useBrowserDrawerStore } from '../../stores/browser-drawer-store';

export function BrowserDrawerFrame({ children }: { children: ReactNode }) {
  const width = useBrowserDrawerStore((s) => s.width);
  const chatMinWidth = useBrowserDrawerStore((s) => s.chatMinWidth);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return (
    <div className="flex h-full shrink-0 flex-col" style={{ width: clampDrawerWidth(width, windowWidth, chatMinWidth) }}>
      {children}
    </div>
  );
}
