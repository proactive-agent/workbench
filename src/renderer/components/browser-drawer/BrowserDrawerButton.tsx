import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { useBrowserDrawerStore, projectSessions } from '../../stores/browser-drawer-store';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface BrowserDrawerButtonProps {
  /** The window's project: a dot shows while the browsers the drawer shows (the chat's, on the Claude page) are open */
  projectId: string;
  className?: string;
}

/** An icon button that shows or hides the browser drawer (pages that place it in their own top bar) */
export function BrowserDrawerButton({ projectId, className }: BrowserDrawerButtonProps) {
  const { t } = useTranslation('navigation');
  const open = useBrowserDrawerStore((s) => s.open);
  const sessionCount = useBrowserDrawerStore((s) => projectSessions(s.state.sessions, projectId, s.chatId).length);
  const setOpen = useBrowserDrawerStore((s) => s.setOpen);

  const label = open
    ? t('browserDrawer.hide')
    : sessionCount > 0 ? t('browserDrawer.openWithSessions', { count: sessionCount }) : t('browserDrawer.open');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('electron-no-drag relative h-8 w-8 text-muted-foreground', open && 'bg-nav-hover text-foreground', className)}
          onClick={() => setOpen(!open)}
          aria-pressed={open}
          aria-label={label}
        >
          <Globe className="h-4 w-4" />
          {sessionCount > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
