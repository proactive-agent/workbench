/**
 * The agent window running the shown chat's Claude Code session too (opened with the chat's Clawd
 * button, or the chat opened from the window), and what it is doing
 * (main: session-messaging/shared-session.ts). While its Claude Code works the chat doesn't send,
 * edit or regenerate; while it is idle, what it said comes into the chat.
 *
 * Followed while the chat has a session: a window opened for it is found once it has started the
 * session. The main process only asks `claude agents` about windows that recorded the session, so
 * a chat without one costs a read of the project's session records.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InsightsSession, SharedSessionWindow } from '../../shared/types';

/** How often the window is looked at while the chat is shown */
const POLL_MS = 4000;

export function useSharedSessionWindow(projectId: string | undefined, session: InsightsSession | null): {
  terminalId: string | null;
  busy: boolean;
  /** Looked at again now (before a send: the state shown may be up to POLL_MS old) */
  check: () => Promise<SharedSessionWindow | null>;
} {
  const claudeSessionId = session?.claudeHead?.sessionId;
  const chatId = session?.id;
  const [found, setFound] = useState<SharedSessionWindow | null>(null);
  const target = useRef({ projectId, claudeSessionId });
  target.current = { projectId, claudeSessionId };

  const check = useCallback(async (): Promise<SharedSessionWindow | null> => {
    const { projectId: project, claudeSessionId: id } = target.current;
    if (!project || !id) return null;
    const result = await window.electronAPI.getSessionWindow(project, id).catch(() => null);
    const next = result?.success ? result.data ?? null : null;
    // Still the chat this was asked for
    if (target.current.projectId === project && target.current.claudeSessionId === id) setFound(next);
    return next;
  }, []);

  useEffect(() => {
    setFound(null);
    if (!projectId || !claudeSessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      const next = await check();
      if (cancelled) return;
      // While the window is idle, what was said there comes in (a turn too quick to be seen
      // working too; the transcript is only read when it changed)
      if (next && chatId && !next.busy) void window.electronAPI.syncSharedSession(projectId, chatId);
      timer = setTimeout(() => void look(), POLL_MS);
    };
    void look();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, claudeSessionId, chatId, check]);

  return { terminalId: found?.terminalId ?? null, busy: found?.busy === true, check };
}
