import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, History, Loader2, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ClaudeSessionItem } from '../../../shared/types';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../../lib/utils';
import { useTerminalStore } from '../../stores/terminal-store';

interface SessionSelectorProps {
  terminalId: string;
  /** Width cap for the trigger label */
  labelClassName?: string;
}

/**
 * The agent window's Claude Code session: "New session" ends the open one and starts a new one, and
 * the list is what `/resume` offers in the window's folder (each session's title, its id under it).
 * Picking one ends the open session and resumes that one in the window. Listed when the menu opens,
 * as `/resume` reads them when it runs.
 */
export function SessionSelector({ terminalId, labelClassName }: SessionSelectorProps) {
  const { t } = useTranslation(['terminal']);
  const listboxId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [sessions, setSessions] = useState<ClaudeSessionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const getOptionId = (index: number) => `${listboxId}-option-${index}`;

  // The open session's title for the trigger, once the list has been read
  const current = sessions.find((session) => session.current);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    window.electronAPI.listClaudeSessions(terminalId)
      .then((result) => {
        if (cancelled) return;
        if (result.success) setSessions(result.data ?? []);
        else setError(result.error ?? t('terminal:session.loadFailed'));
      })
      .catch(() => {
        if (!cancelled) setError(t('terminal:session.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, terminalId, t]);

  const filtered = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return sessions;
    return sessions.filter((session) =>
      (session.name ?? '').toLowerCase().includes(query) || session.sessionId.toLowerCase().includes(query)
    );
  }, [sessions, searchQuery]);

  const open = useCallback((sessionId: string | null) => {
    setIsOpen(false);
    // The open session again: nothing to do
    if (sessionId && sessions.find((session) => session.sessionId === sessionId)?.current) return;
    // The trigger names the session the window now opens (none yet for a new one)
    setSessions((list) => list.map((session) => ({ ...session, current: session.sessionId === sessionId })));
    useTerminalStore.getState().setCLIMode(terminalId, true);
    // A spinner over the window until the session is up (the old one exits, the new one starts)
    useTerminalStore.getState().setTerminalLoading(terminalId, 'claude');
    void window.electronAPI.openClaudeSession(terminalId, sessionId).then((result) => {
      if (!result.success) {
        useTerminalStore.getState().setTerminalLoading(terminalId, undefined);
        console.warn('[SessionSelector] Could not open the session:', result.error);
      }
    });
  }, [sessions, terminalId]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setFocusedIndex((index) => (index + 1) % Math.max(filtered.length, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setFocusedIndex((index) => (index <= 0 ? Math.max(filtered.length - 1, 0) : index - 1));
        break;
      case 'Enter':
        event.preventDefault();
        if (filtered[focusedIndex]) open(filtered[focusedIndex].sessionId);
        break;
      case 'Escape':
        event.preventDefault();
        setIsOpen(false);
        break;
    }
  }, [filtered, focusedIndex, open]);

  useEffect(() => {
    setFocusedIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    itemRefs.current.get(focusedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const handleOpenChange = (next: boolean) => {
    setIsOpen(next);
    if (!next) {
      setSearchQuery('');
      setFocusedIndex(0);
    }
  };

  const label = current?.name ?? t('terminal:session.label');

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors',
            'hover:bg-nav-hover hover:text-foreground text-muted-foreground'
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <History className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          <span className={cn('truncate', labelClassName)} title={label}>{label}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto min-w-[15rem] max-w-[22rem] p-1.5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInputRef.current?.focus();
        }}
      >
        {/* Pinned: end the open session and start a new one */}
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-nav-hover"
          onClick={(event) => {
            event.stopPropagation();
            open(null);
          }}
        >
          <Plus className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
          {t('terminal:session.new')}
        </button>
        <div className="-mx-1.5 my-1.5 h-px bg-border" />
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <input
            ref={searchInputRef}
            type="search"
            role="combobox"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-activedescendant={filtered.length > 0 ? getOptionId(focusedIndex) : undefined}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('terminal:session.searchPlaceholder')}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-(--field-placeholder)"
          />
        </div>
        <div className="-mx-1.5 my-1.5 h-px bg-border" />
        <div className="max-h-[min(500px,60vh)] overflow-y-auto">
          <div id={listboxId} role="listbox" aria-label={t('terminal:session.searchPlaceholder')}>
            {isLoading ? (
              <div className="flex items-center justify-center py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="px-3 py-2 text-sm text-(--nav-label-color)">{error}</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-(--nav-label-color)">{t('terminal:session.noResults')}</div>
            ) : (
              filtered.map((session, index) => (
                <div
                  key={session.sessionId}
                  id={getOptionId(index)}
                  ref={(element) => {
                    if (element) itemRefs.current.set(index, element);
                    else itemRefs.current.delete(index);
                  }}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === focusedIndex}
                  className={cn(
                    'flex cursor-pointer items-center rounded-lg px-3 py-2 text-sm text-foreground',
                    index === focusedIndex ? 'bg-nav-hover' : 'hover:bg-nav-hover'
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    open(session.sessionId);
                  }}
                  onMouseEnter={() => setFocusedIndex(index)}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{session.name ?? t('terminal:session.untitled')}</span>
                    <span className="truncate font-mono text-xs text-(--nav-label-color)">{session.sessionId}</span>
                  </div>
                  {session.current && (
                    <span className="ml-2 shrink-0 text-xs text-(--nav-label-color)">{t('terminal:session.current')}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
