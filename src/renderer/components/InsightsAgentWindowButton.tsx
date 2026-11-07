/**
 * The Claude page's "Open in agent window" button (top bar, under the browser button): opens the
 * chat's Claude Code session in a new agent window of the project (`claude --resume`, on the
 * account it ran on), like a task's "Open agent" button. Hidden until the chat has a session;
 * disabled while the chat replies (its turn is writing the session) or when the project has no
 * room for another window.
 */
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
}

export function InsightsAgentWindowButton({ projectId, session, replying }: InsightsAgentWindowButtonProps) {
  const { t } = useTranslation('common');
  const projectPath = useProjectStore((state) => state.projects.find((project) => project.id === projectId)?.path);
  const canAddWindow = useTerminalStore((state) => (projectPath ? state.canAddTerminal(projectPath) : false));

  // The session the chat's latest reply ended in (edits and regenerations fork into a new one)
  const ref = [...(session?.messages ?? [])].reverse().find((message) => message.claudeRef)?.claudeRef;
  if (!session || !ref || !projectPath) return null;

  const reason = replying
    ? t('insights.agentWindow.replying')
    : !canAddWindow
      ? t('insights.agentWindow.noRoom')
      : null;
  const label = t('insights.agentWindow.open');

  const handleOpen = () => {
    if (reason) return;
    useTerminalStore.getState().openProjectSession({
      projectPath,
      title: session.title || label,
      sessionId: ref.sessionId,
      profileId: ref.profileId,
    });
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
            onClick={handleOpen}
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
