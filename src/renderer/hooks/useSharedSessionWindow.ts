/**
 * The agent window running the shown chat's Claude Code session too (opened with the chat's Clawd
 * button, or the chat opened from the window), and whether its Claude Code is working
 * (main: session-messaging/shared-session.ts, from `claude agents`). While it works the chat
 * doesn't send, edit or regenerate; when its turn ends, what it said comes into the chat.
 */
import { useEffect, useState } from 'react';
import { useTerminalStore } from '../stores/terminal-store';
import type { InsightsSession, SharedSessionWindow } from '../../shared/types';

/** How often the window's state is asked while one shares the chat's session (`claude agents`) */
const POLL_MS = 4000;

export function useSharedSessionWindow(projectId: string | undefined, session: InsightsSession | null): { terminalId: string | null; busy: boolean } {
  const claudeSessionId = session?.claudeHead?.sessionId;
  const chatId = session?.id;
  // Looked for again when windows open, close, start or leave Claude Code
  const windowsKey = useTerminalStore((state) => state.terminals.map((terminal) => `${terminal.id}:${terminal.isCLIMode ? 1 : 0}`).join(' '));
  const [found, setFound] = useState<SharedSessionWindow | null>(null);

  useEffect(() => {
    setFound(null);
    if (!projectId || !claudeSessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      const result = await window.electronAPI.getSessionWindow(projectId, claudeSessionId).catch(() => null);
      if (cancelled) return;
      const next = result?.success ? result.data ?? null : null;
      setFound(next);
      // While the window is idle, what was said there comes in (a turn too quick to be seen
      // working too; nothing is read unless the session changed since the chat did)
      if (next && chatId && !next.busy) void window.electronAPI.syncSharedSession(projectId, chatId);
      // Followed while a window shares the session
      if (next) timer = setTimeout(() => void look(), POLL_MS);
    };
    void look();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, claudeSessionId, chatId, windowsKey]);

  return { terminalId: found?.terminalId ?? null, busy: found?.busy === true };
}
