/**
 * The chat composer's `/` menu (with the Clawd button on): Claude Code's slash commands and skills
 * in the project, listed when the caret follows a `/` that starts the input or a word, filtered
 * by what was typed after it, as in Claude Code's own prompt. A picked command takes the token's
 * place in the message.
 *
 * The commands (main: insights/chat-commands.ts) are kept per project and account, since the
 * account's config dir holds the user's skills and plugins. They are asked when first needed and
 * again each time the Clawd button is switched on (new skills or plugins show up then), keeping
 * the list on screen meanwhile; a failed request is retried when the menu opens again.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatCommandsError, ChatSlashCommand } from '../../shared/types';

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

/** A run of the input's text, and whether it is a listed slash command (shown in the primary color) */
export interface SlashTextPart {
  text: string;
  command: boolean;
}

/**
 * The input split around the slash commands it names: a `/name` starting the input or a word and
 * ending at a space or the end, whose name is in `names` (the menu's commands, so a path or any
 * other word starting with `/` isn't one)
 */
export function splitSlashCommands(value: string, names: ReadonlySet<string>): SlashTextPart[] {
  const parts: SlashTextPart[] = [];
  let last = 0;
  for (const match of value.matchAll(/(^|\s)\/([^\s/]+)(?=\s|$)/g)) {
    if (!names.has(match[2])) continue;
    const start = match.index + match[1].length;
    if (start > last) parts.push({ text: value.slice(last, start), command: false });
    const end = start + match[2].length + 1;
    parts.push({ text: value.slice(start, end), command: true });
    last = end;
  }
  if (last < value.length) parts.push({ text: value.slice(last), command: false });
  return parts;
}

/** The input with the token replaced by the command (and a space), and the caret after it */
export function insertSlashCommand(value: string, token: SlashToken, caret: number, name: string): { value: string; caret: number } {
  const inserted = `/${name} `;
  const rest = value.slice(caret).replace(/^\S*/, '').replace(/^ /, '');
  return { value: value.slice(0, token.start) + inserted + rest, caret: token.start + inserted.length };
}

type CommandsState =
  | { status: 'loading'; commands?: ChatSlashCommand[] }
  | { status: 'ready'; commands: ChatSlashCommand[] }
  | { status: 'error'; error: ChatCommandsError };

/** The commands of each project and account (`projectId`, account key) */
const commandsByKey = new Map<string, CommandsState>();
const pending = new Map<string, Promise<CommandsState>>();

const CHAT_COMMANDS_ERRORS: readonly ChatCommandsError[] = ['projectNotFound', 'timeout', 'notListed', 'failed'];

function loadCommands(key: string, projectId: string): Promise<CommandsState> {
  const existing = pending.get(key);
  if (existing) return existing;
  const request = window.electronAPI.listInsightsCommands(projectId)
    .then((result): CommandsState => {
      if (result.success && result.data) return { status: 'ready', commands: result.data };
      const code = CHAT_COMMANDS_ERRORS.find((known) => known === result.error) ?? 'failed';
      return { status: 'error', error: code };
    })
    .catch((): CommandsState => ({ status: 'error', error: 'failed' }))
    .then((state) => {
      // A failed refresh keeps the list it had
      const previous = commandsByKey.get(key);
      const next = state.status === 'error' && previous?.status === 'loading' && previous.commands
        ? { status: 'ready' as const, commands: previous.commands }
        : state;
      commandsByKey.set(key, next);
      pending.delete(key);
      return next;
    });
  pending.set(key, request);
  return request;
}

interface SlashMenuOptions {
  projectId: string;
  /** The account the chat's turns run on (the commands depend on its config dir) */
  accountKey: string;
  /** The Clawd button is on: the menu works only then */
  enabled: boolean;
  value: string;
  caret: number;
  /** Apply the input after a command was picked */
  onInsert: (value: string, caret: number) => void;
}

/** The `/` menu's state and keyboard handling for the composer */
export function useSlashCommandMenu({ projectId, accountKey, enabled, value, caret, onInsert }: SlashMenuOptions) {
  const key = `${projectId}\n${accountKey}`;
  const [commands, setCommands] = useState<CommandsState | undefined>(() => commandsByKey.get(key));
  const [activeIndex, setActiveIndex] = useState(0);
  // The token the user closed the menu on (Escape): it stays closed until another one starts
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const token = enabled ? slashTokenAt(value, caret) : null;
  const open = !!token && token.start !== dismissedAt;

  const keyRef = useRef(key);
  keyRef.current = key;

  const load = (refresh: boolean) => {
    const current = commandsByKey.get(key);
    if (!refresh && current && current.status !== 'error') return;
    // Loading again keeps the list on screen
    const keep = current?.status === 'ready' ? current.commands : current?.status === 'loading' ? current.commands : undefined;
    if (!pending.has(key)) commandsByKey.set(key, { status: 'loading', commands: keep });
    setCommands(commandsByKey.get(key));
    void loadCommands(key, projectId).then((state) => {
      if (keyRef.current === key) setCommands(state);
    });
  };

  // Switching the Clawd button on asks again (new skills and plugins show up); another project or
  // account shows its own list, asked when it has none
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    const switchedOn = enabled && !wasEnabled.current;
    wasEnabled.current = enabled;
    setCommands(commandsByKey.get(key));
    if (enabled) load(switchedOn);
    // `load` reads the current key, which is a dependency
  }, [key, enabled]);

  // A failed list is asked again when the menu opens
  useEffect(() => {
    if (open && commands?.status === 'error') load(false);
  }, [open, token?.start]);

  const listed = commands?.status === 'ready' || commands?.status === 'loading' ? commands.commands : undefined;
  // The names the composer colors in its text (with the Clawd button on)
  const names = useMemo(() => new Set(enabled && listed ? listed.map((command) => command.name) : []), [enabled, listed]);
  const items = useMemo(
    () => (open && listed ? filterSlashCommands(listed, token.query) : []),
    [open, listed, token?.query]
  );

  // A new query starts at the top
  useEffect(() => setActiveIndex(0), [token?.query, token?.start]);
  // A new token can open the menu again
  useEffect(() => {
    if (dismissedAt !== null && token?.start !== dismissedAt) setDismissedAt(null);
  }, [token?.start, dismissedAt]);

  const select = (command: ChatSlashCommand) => {
    if (!token) return;
    const next = insertSlashCommand(value, token, caret, command.name);
    onInsert(next.value, next.caret);
  };

  /** Keys the open menu takes (arrows, Enter or Tab to pick, Escape to close); true when handled */
  const handleKeyDown = (e: KeyboardEvent): boolean => {
    // Keys of an input method (IME) composing text are its own
    if (!open || !token || e.nativeEvent.isComposing) return false;
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
    const active = items[Math.min(activeIndex, items.length - 1)];
    // Enter on a command typed out in full sends it, as in Claude Code's prompt
    if (e.key === 'Enter' && !e.shiftKey && active.name.toLowerCase() !== token.query.toLowerCase()) {
      e.preventDefault();
      select(active);
      return true;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      select(active);
      return true;
    }
    return false;
  };

  const loading = !commands || commands.status === 'loading';
  // Shown while open: the matches, or the list's state while it loads (with nothing to show yet)
  // or when it failed
  const visible = open && (items.length > 0 || (loading && !listed) || commands?.status === 'error');
  return {
    open: visible,
    items,
    activeIndex: Math.min(activeIndex, Math.max(items.length - 1, 0)),
    setActiveIndex,
    loading,
    error: commands?.status === 'error' ? commands.error : null,
    select,
    handleKeyDown,
    names,
  };
}
