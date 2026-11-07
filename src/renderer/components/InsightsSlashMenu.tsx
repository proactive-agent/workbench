/**
 * The composer's `/` menu: Claude Code's slash commands and skills matching what was typed after
 * the slash (state and keys: insights-slash-commands.ts). Sits above the composer; the textarea
 * keeps focus, so the menu is driven by its keys and picked with the mouse too.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import type { ChatSlashCommand } from '../../shared/types';

interface InsightsSlashMenuProps {
  items: ChatSlashCommand[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  onSelect: (command: ChatSlashCommand) => void;
  onHover: (index: number) => void;
}

export function InsightsSlashMenu({ items, activeIndex, loading, error, onSelect, onHover }: InsightsSlashMenuProps) {
  const { t } = useTranslation('common');
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the active command in view while moving with the arrows
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('insights.slashCommands.label')}
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-popover p-1 shadow-lg"
      // Clicks keep the textarea's focus (and caret)
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.length === 0 ? (
        <p className={cn('px-3 py-2 text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>
          {error && !loading ? t('insights.slashCommands.failed', { error }) : t('insights.slashCommands.loading')}
        </p>
      ) : (
        items.map((command, index) => (
          <div
            key={command.name}
            role="option"
            data-index={index}
            aria-selected={index === activeIndex}
            onMouseEnter={() => onHover(index)}
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
    </div>
  );
}
