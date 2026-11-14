/**
 * The composer's `/` menu: Claude Code's slash commands and skills matching what was typed after
 * the slash (state and keys: insights-slash-commands.ts). The textarea keeps focus, so the menu is
 * driven by its keys and picked with the mouse too. It is drawn over the page (a portal placed at
 * the composer), above the composer when there is room there and below it otherwise, so the chat's
 * scrolling column never cuts it off.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import type { ChatCommandsError, ChatSlashCommand } from '../../shared/types';

/** Tallest the menu gets, the least room above the composer it opens in, and its gap to it */
const MENU_MAX_HEIGHT = 288;
const MENU_MIN_HEIGHT = 120;
const MENU_GAP = 8;

interface InsightsSlashMenuProps {
  /** The composer the menu is placed at */
  anchorRef: RefObject<HTMLElement | null>;
  items: ChatSlashCommand[];
  activeIndex: number;
  loading: boolean;
  error: ChatCommandsError | null;
  onSelect: (command: ChatSlashCommand) => void;
  onHover: (index: number) => void;
}

interface MenuPlace {
  left: number;
  width: number;
  maxHeight: number;
  /** Top edge (below the composer) or bottom edge (above it), in viewport pixels */
  top?: number;
  bottom?: number;
}

export function InsightsSlashMenu({ anchorRef, items, activeIndex, loading, error, onSelect, onHover }: InsightsSlashMenuProps) {
  const { t } = useTranslation('common');
  const listRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<MenuPlace | null>(null);

  // Placed at the composer, and again when it resizes, the window resizes or the page scrolls
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const above = rect.top - MENU_GAP * 2;
      const below = window.innerHeight - rect.bottom - MENU_GAP * 2;
      const useAbove = above >= MENU_MIN_HEIGHT || above >= below;
      setPlace({
        left: rect.left,
        width: rect.width,
        maxHeight: Math.max(Math.min(MENU_MAX_HEIGHT, useAbove ? above : below), 0),
        ...(useAbove ? { bottom: window.innerHeight - rect.top + MENU_GAP } : { top: rect.bottom + MENU_GAP }),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef]);

  // Keep the active command in view while moving with the arrows
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!place) return null;
  return createPortal(
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('insights.slashCommands.label')}
      style={{ left: place.left, width: place.width, maxHeight: place.maxHeight, top: place.top, bottom: place.bottom }}
      className="fixed z-50 overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-popover p-1 shadow-lg"
      // Clicks keep the textarea's focus (and caret)
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.length === 0 ? (
        <p className={cn('px-3 py-2 text-sm', error && !loading ? 'text-destructive' : 'text-muted-foreground')}>
          {error && !loading ? t(`insights.slashCommands.errors.${error}`) : t('insights.slashCommands.loading')}
        </p>
      ) : (
        items.map((command, index) => (
          <div
            key={command.name}
            role="option"
            data-index={index}
            aria-selected={index === activeIndex}
            // Moving the pointer picks a row; a row scrolling under a still pointer doesn't
            onMouseMove={() => {
              if (index !== activeIndex) onHover(index);
            }}
            onClick={() => onSelect(command)}
            className={cn(
              'flex min-w-0 cursor-pointer items-baseline gap-3 rounded-lg px-3 py-1.5 text-sm',
              index === activeIndex ? 'bg-nav-hover text-foreground' : 'text-foreground'
            )}
          >
            {/* Both parts end in an ellipsis when they don't fit; the command keeps up to 60% of the row */}
            <span
              className="min-w-0 max-w-[60%] shrink-0 truncate font-mono text-[0.8125rem]"
              title={command.argumentHint ? `/${command.name} ${command.argumentHint}` : `/${command.name}`}
            >
              /{command.name}
              {command.argumentHint && <span className="text-muted-foreground"> {command.argumentHint}</span>}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={command.description}>
              {command.description}
            </span>
          </div>
        ))
      )}
    </div>,
    document.body
  );
}
