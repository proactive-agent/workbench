/**
 * The chat composer's `/` menu (with the Clawd button on): Claude Code's slash commands and skills
 * in the project, listed when the caret follows a `/` that starts the input or a word, filtered
 * by what was typed after it, as in Claude Code's own prompt. The commands are asked once per
 * project (main: insights/chat-commands.ts) and kept for the app's session.
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { ChatSlashCommand } from '../../shared/types';

/** The `/` token the caret is in: where it starts and what follows the slash */
export interface SlashToken {
  start: number;
  query: string;
}

/** The `/` token that ends at the caret, or null (a `/` inside a word or a path isn't one) */
export function slashTokenAt(value: string, caret: number): SlashToken | null {
  const match = /(^|\s)\/([^\s/]*)$/.exec(value.slice(0, caret));
  if (!match) return null;
  return { start: match.index + match[1].length, query: match[2] };
}

/** Commands matching the query: names starting with it first, then names containing it */
export function filterSlashCommands(commands: ChatSlashCommand[], query: string): ChatSlashCommand[] {
  const q = query.toLowerCase();
  const byName = (a: ChatSlashCommand, b: ChatSlashCommand) => a.name.localeCompare(b.name);
  const starts = commands.filter((command) => command.name.toLowerCase().startsWith(q)).sort(byName);
  const contains = q
    ? commands.filter((command) => !command.name.toLowerCase().startsWith(q) && command.name.toLowerCase().includes(q)).sort(byName)
    : [];
  return [...starts, ...contains];
}

/** The input with the token replaced by the command (and a space), and the caret after it */
export function insertSlashCommand(value: string, token: SlashToken, caret: number, name: string): { value: string; caret: number } {
  const inserted = `/${name} `;
  const rest = value.slice(caret).replace(/^\S*/, '');
  return { value: value.slice(0, token.start) + inserted + rest.replace(/^ /, ''), caret: token.start + inserted.length };
}

type CommandsState = { status: 'loading' } | { status: 'ready'; commands: ChatSlashCommand[] } | { status: 'error'; error: string };

/** Each project's commands, asked once per app session */
const commandsByProject = new Map<string, CommandsState>();
const pending = new Map<string, Promise<CommandsState>>();

function loadCommands(projectId: string): Promise<CommandsState> {
  const existing = pending.get(projectId);
  if (existing) return existing;
  const request = window.electronAPI.listInsightsCommands(projectId)
    .then((result): CommandsState => result.success && result.data
      ? { status: 'ready', commands: result.data }
      : { status: 'error', error: result.error ?? '' })
    .catch((error: unknown): CommandsState => ({ status: 'error', error: error instanceof Error ? error.message : String(error) }))
    .then((state) => {
      commandsByProject.set(projectId, state);
      pending.delete(projectId);
      return state;
    });
  pending.set(projectId, request);
  return request;
}

interface SlashMenuOptions {
  projectId: string;
  /** The Clawd button is on: the menu works only then */
  enabled: boolean;
  value: string;
  caret: number;
  /** Apply the input after a command was picked */
  onInsert: (value: string, caret: number) => void;
}

/** The `/` menu's state and keyboard handling for the composer */
export function useSlashCommandMenu({ projectId, enabled, value, caret, onInsert }: SlashMenuOptions) {
  const [commands, setCommands] = useState<CommandsState | undefined>(() => commandsByProject.get(projectId));
  const [activeIndex, setActiveIndex] = useState(0);
  // The token the user closed the menu on (Escape): it stays closed until another one starts
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const token = enabled ? slashTokenAt(value, caret) : null;
  const open = !!token && token.start !== dismissedAt;

  // Asked once the menu is first needed (stored for the app's session afterwards; asked again
  // only after a failure)
  useEffect(() => {
    setCommands(commandsByProject.get(projectId));
    if (!enabled || commandsByProject.get(projectId)?.status === 'ready') return;
    let cancelled = false;
    void loadCommands(projectId).then((state) => {
      if (!cancelled) setCommands(state);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, enabled]);

  const items = useMemo(
    () => (open && commands?.status === 'ready' ? filterSlashCommands(commands.commands, token.query) : []),
    [open, commands, token?.query]
  );

  // A new query starts at the top
  useEffect(() => setActiveIndex(0), [token?.query, token?.start]);
  // A new token can open the menu again
  useEffect(() => {
    if (dismissedAt !== null && token?.start !== dismissedAt) setDismissedAt(null);
  }, [token?.start, dismissedAt]);

  const select = useCallback((command: ChatSlashCommand) => {
    if (!token) return;
    const next = insertSlashCommand(value, token, caret, command.name);
    onInsert(next.value, next.caret);
  }, [token, value, caret, onInsert]);

  /** Keys the open menu takes (arrows, Enter or Tab to pick, Escape to close); true when handled */
  const handleKeyDown = (e: KeyboardEvent): boolean => {
    if (!open || !token) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissedAt(token.start);
      return true;
    }
    if (items.length === 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + step + items.length) % items.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      select(items[Math.min(activeIndex, items.length - 1)]);
      return true;
    }
    return false;
  };

  // Shown while open: the matches, or the list's state while it loads or when it failed
  const visible = open && (items.length > 0 || commands === undefined || commands.status !== 'ready');
  return {
    open: visible,
    items,
    activeIndex: Math.min(activeIndex, Math.max(items.length - 1, 0)),
    setActiveIndex,
    loading: !commands || commands.status === 'loading',
    error: commands?.status === 'error' ? commands.error : null,
    select,
    handleKeyDown,
  };
}
