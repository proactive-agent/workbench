/**
 * The Claude page's copy-name button (top bar, under "Open agent"): copies the chat's stable name
 * (chat-…), which the project's other chats and agent windows message it by. Hidden until the
 * chat is saved (its first message).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { chatSessionName } from '../../shared/utils/session-names';
import type { InsightsSession } from '../../shared/types';

/** How long the copied state shows */
const COPIED_MS = 2000;

export function InsightsChatNameButton({ session }: { session: InsightsSession | null }) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const name = session ? chatSessionName(session.id) : null;
  if (!name) return null;
  const label = copied ? t('insights.chatName.copied', { name }) : t('insights.chatName.copy', { name });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="electron-no-drag h-8 w-8 text-muted-foreground"
          onClick={() => {
            void navigator.clipboard.writeText(name).then(() => setCopied(true)).catch(() => undefined);
          }}
          aria-label={label}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-72">{label}</TooltipContent>
    </Tooltip>
  );
}
