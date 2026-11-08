/**
 * An agent window's header buttons for its Claude Code session as a whole: open the session as a
 * Claude chat of the project ("Open as chat", the counterpart of a chat's "Open agent") and copy the
 * window's stable name (other chats and windows message it by that name). "Open as chat" is disabled
 * while the window's Claude Code is working. While the window answers a chat's message it is
 * read-only, which a label here says, with a Take over button that gives the window back.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui/button';
import { InsightsIcon, MessagesIcon } from '../icons/app-icons';
import { cn } from '../../lib/utils';
import { useProjectStore } from '../../stores/project-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { openWindowAsChat } from '../../stores/insights-store';
import { agentSessionName } from '../../../shared/utils/session-names';

interface WindowSessionButtonsProps {
  terminalId: string;
  projectPath: string;
}

/** How long the copied state and an error show */
const FEEDBACK_MS = 2000;

export function WindowSessionButtons({ terminalId, projectPath }: WindowSessionButtonsProps) {
  const { t } = useTranslation(['terminal']);
  const projectId = useProjectStore((state) => state.projects.find((project) => project.path === projectPath)?.id);
  const busy = useTerminalStore((state) => state.terminals.find((terminal) => terminal.id === terminalId)?.isClaudeBusy === true);
  const receivingFrom = useTerminalStore((state) => state.terminals.find((terminal) => terminal.id === terminalId)?.receivingFrom);
  const name = agentSessionName(terminalId);
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied && !error) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setError(null);
    }, FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied, error]);

  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(true);
    } catch {
      // Clipboard unavailable: nothing to show
    }
  };

  const openAsChat = async () => {
    if (!projectId || opening || busy) return;
    setOpening(true);
    setError(null);
    try {
      const failure = await openWindowAsChat(projectId, terminalId);
      if (failure) setError(t(`terminal:header.openAsChatErrors.${failure}`, { defaultValue: t('terminal:header.openAsChatErrors.failed') }));
    } finally {
      setOpening(false);
    }
  };

  const copyLabel = copied ? t('terminal:header.copiedName', { name }) : t('terminal:header.copyName', { name });
  return (
    <>
      {receivingFrom && (
        <span
          className="flex min-w-0 items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary"
          title={t('terminal:header.receivingTitle', { title: receivingFrom.title ?? receivingFrom.name, name: receivingFrom.name })}
        >
          <MessagesIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="max-w-48 truncate">{t('terminal:header.receiving', { title: receivingFrom.title ?? receivingFrom.name })}</span>
          <button
            type="button"
            className="shrink-0 font-medium underline-offset-2 hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              window.electronAPI.takeOverTerminal(terminalId);
            }}
          >
            {t('terminal:header.takeOver')}
          </button>
        </span>
      )}
      {projectId && (
        // The wrapper keeps the tooltip on the disabled button
        <span className="inline-flex" title={error ?? (busy ? t('terminal:header.openAsChatBusy') : t('terminal:header.openAsChat'))}>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8 hover:bg-nav-hover', error && 'text-destructive hover:text-destructive')}
            onClick={(e) => {
              e.stopPropagation();
              void openAsChat();
            }}
            disabled={opening || busy}
            aria-label={t('terminal:header.openAsChat')}
          >
            <InsightsIcon className="h-4 w-4" />
          </Button>
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 hover:bg-nav-hover"
        onClick={(e) => {
          e.stopPropagation();
          void copyName();
        }}
        title={copyLabel}
        aria-label={copyLabel}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </>
  );
}
