/**
 * The Claude page's "Open in agent window" button (top bar, under the browser button): shows the
 * chat's Claude Code session in an agent window of the project, the one running it already, else a
 * new one resuming it (`claude --resume`, on the account it ran on) as its own, like a task's "Open
 * agent" button. The chat and the window then share the session and take turns in it
 * (main: session-messaging/shared-session.ts). Hidden until the chat has a session; disabled while
 * the chat replies (its turn is writing the session) or, without a window running it, when the
 * project has no room for another window.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { ClawdIcon } from './icons/app-icons';
import { useProjectStore } from '../stores/project-store';
import { useTerminalStore } from '../stores/terminal-store';
import type { InsightsSession } from '../../shared/types';

interface InsightsAgentWindowButtonProps {
  projectId: string;
  session: InsightsSession | null;
  /** The chat is replying */
  replying: boolean;
  /** The agent window running the chat's session already, if one does */
  windowId: string | null;
}

export function InsightsAgentWindowButton({ projectId, session, replying, windowId }: InsightsAgentWindowButtonProps) {
  const { t } = useTranslation('common');
  const projectPath = useProjectStore((state) => state.projects.find((project) => project.id === projectId)?.path);
  const canAddWindow = useTerminalStore((state) => (projectPath ? state.canAddTerminal(projectPath) : false));
  // A click waiting for the window lookup: a second one opens nothing more
  const openingRef = useRef(false);

  // The session the chat's latest reply ended in (edits and regenerations fork into a new one)
  const ref = [...(session?.messages ?? [])].reverse().find((message) => message.claudeRef)?.claudeRef;
  if (!session || !ref || !projectPath) return null;

  const reason = replying
    ? t('insights.agentWindow.replying')
    : !canAddWindow && !windowId
      ? t('insights.agentWindow.noRoom')
      : null;
  const label = t('insights.agentWindow.open');

  const handleOpen = async () => {
    if (reason || openingRef.current) return;
    openingRef.current = true;
    try {
      // The window running the session now (it may have changed since the chat last looked)
      const found = await window.electronAPI.getSessionWindow(projectId, ref.sessionId).catch(() => null);
      const shared = found?.success ? found.data ?? null : null;
      const terminalId = found?.success ? shared?.terminalId ?? null : windowId;
      if (!terminalId && !useTerminalStore.getState().canAddTerminal(projectPath)) return;
      useTerminalStore.getState().openProjectSession({
        projectPath,
        title: session.title || label,
        sessionId: ref.sessionId,
        profileId: ref.profileId,
        terminalId,
        resume: shared?.resumable === true,
      });
    } finally {
      openingRef.current = false;
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The wrapper keeps the tooltip on a disabled button */}
        <span className="electron-no-drag inline-flex">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground"
            onClick={() => void handleOpen()}
            disabled={!!reason}
            aria-label={label}
          >
            <ClawdIcon className="h-4 w-4" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">{reason ?? label}</TooltipContent>
    </Tooltip>
  );
}
