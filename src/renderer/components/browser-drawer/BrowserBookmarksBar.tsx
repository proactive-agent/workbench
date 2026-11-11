import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsRight, Folder, Globe } from 'lucide-react';
import type { BrowserBookmark } from '../../../shared/types/browser-drawer';
import { useBrowserDrawerStore } from '../../stores/browser-drawer-store';
import { cn } from '../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

interface BrowserBookmarksBarProps {
  /** The browser whose profile's bookmarks bar shows */
  sessionId: string;
  /** Open a bookmark in the tab shown */
  onOpen: (url: string) => void;
}

const itemClass = cn(
  'flex h-6 max-w-[11rem] shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground',
  'transition-colors duration-150 hover:bg-nav-hover hover:text-foreground data-[state=open]:bg-nav-hover',
  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)'
);
const menuClass = 'max-h-[70vh] max-w-[20rem] overflow-y-auto';
/** Room kept for the button listing the bookmarks that don't fit */
const OVERFLOW_BUTTON_WIDTH = 28;
const GAP = 2;
const NO_BOOKMARKS: BrowserBookmark[] = [];

function ItemLabel({ bookmark, untitled }: { bookmark: BrowserBookmark; untitled: string }) {
  const Icon = bookmark.children ? Folder : Globe;
  return (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{bookmark.title || untitled}</span>
    </>
  );
}

/** A folder's or the overflow's items, folders as submenus */
function MenuItems({ items, onOpen, untitled, empty }: { items: BrowserBookmark[]; onOpen: (url: string) => void; untitled: string; empty: string }) {
  if (items.length === 0) return <DropdownMenuItem disabled className="text-xs">{empty}</DropdownMenuItem>;
  return (
    <>
      {items.map((item, index) =>
        item.children ? (
          <DropdownMenuSub key={index}>
            <DropdownMenuSubTrigger className="py-1.5 text-xs"><ItemLabel bookmark={item} untitled={untitled} /></DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={menuClass}>
              <MenuItems items={item.children} onOpen={onOpen} untitled={untitled} empty={empty} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <DropdownMenuItem key={index} className="py-1.5 text-xs" title={item.url} onSelect={() => item.url && onOpen(item.url)}>
            <ItemLabel bookmark={item} untitled={untitled} />
          </DropdownMenuItem>
        )
      )}
    </>
  );
}

/**
 * The bookmarks bar of the browser's profile, always shown under the address bar while it has
 * bookmarks (the drawer's browsers are headless: their own toolbar never shows). Bookmarks that
 * don't fit are listed behind a button at its end, as in the browser
 */
export function BrowserBookmarksBar({ sessionId, onOpen }: BrowserBookmarksBarProps) {
  const { t } = useTranslation('navigation');
  const bookmarks = useBrowserDrawerStore((s) => s.bookmarks[sessionId]);
  const loadBookmarks = useBrowserDrawerStore((s) => s.loadBookmarks);
  useEffect(() => loadBookmarks(sessionId), [sessionId, loadBookmarks]);

  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(Number.POSITIVE_INFINITY);
  const items = bookmarks ?? NO_BOOKMARKS;

  // How many items fit, measured on an unseen copy of the whole bar
  useLayoutEffect(() => {
    const bar = barRef.current;
    const measure = measureRef.current;
    if (!bar || !measure) return;
    const update = () => {
      // Not laid out (hidden): what fits is measured once it shows
      if (bar.clientWidth === 0) return;
      const widths = [...measure.children].map((child) => (child as HTMLElement).offsetWidth + GAP);
      const total = widths.reduce((sum, width) => sum + width, 0);
      if (total <= bar.clientWidth) return setFits(widths.length);
      let used = OVERFLOW_BUTTON_WIDTH;
      let count = 0;
      while (count < widths.length && used + widths[count] <= bar.clientWidth) used += widths[count++];
      setFits(count);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;
  const untitled = t('browserDrawer.untitledBookmark');
  const empty = t('browserDrawer.emptyFolder');
  const shown = items.slice(0, fits);
  const overflow = items.slice(fits);

  return (
    <div
      ref={barRef}
      className="relative flex h-8 shrink-0 items-center overflow-hidden border-b border-border px-2"
      style={{ gap: GAP }}
      role="toolbar"
      aria-label={t('browserDrawer.bookmarks')}
    >
      {/* Unseen copy of every item, measured for what fits */}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex">
        {items.map((item, index) => (
          <span key={index} className={itemClass}><ItemLabel bookmark={item} untitled={untitled} /></span>
        ))}
      </div>
      {shown.map((item, index) =>
        item.children ? (
          <DropdownMenu key={index}>
            <DropdownMenuTrigger className={itemClass} title={item.title}>
              <ItemLabel bookmark={item} untitled={untitled} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className={menuClass}>
              <MenuItems items={item.children} onOpen={onOpen} untitled={untitled} empty={empty} />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button key={index} type="button" className={itemClass} title={item.url} onClick={() => item.url && onOpen(item.url)}>
            <ItemLabel bookmark={item} untitled={untitled} />
          </button>
        )
      )}
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(itemClass, 'ml-auto px-1')}
            aria-label={t('browserDrawer.moreBookmarks')}
            title={t('browserDrawer.moreBookmarks')}
          >
            <ChevronsRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={menuClass}>
            <MenuItems items={overflow} onOpen={onOpen} untitled={untitled} empty={empty} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
