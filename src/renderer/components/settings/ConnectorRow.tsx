import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/** Leading icon tile used by connector rows (claude.ai Connectors style) */
function ConnectorIconTile({ icon: Icon }: { icon: React.ElementType }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-[inset_0_0_0_1px_var(--segment-thumb-ring)]">
      <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
    </div>
  );
}

interface ConnectorRowProps {
  icon: React.ElementType;
  name: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  disabled?: boolean;
}

/** A connector row: icon tile, name + muted description, control on the right */
export function ConnectorRow({ icon, name, description, children, disabled = false }: ConnectorRowProps) {
  return (
    <div className={cn('group flex items-center gap-3 py-3', disabled && 'opacity-60')}>
      <ConnectorIconTile icon={icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-sm text-foreground">{name}</div>
        {description && <div className="truncate text-sm text-(--nav-label-color)">{description}</div>}
      </div>
      {/* data-settings-control: dropdowns here get the same borderless look as in SettingsRow */}
      {children && <div data-settings-control="" className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * A connector's switch; while it is disabled, hovering it shows why (`reason`, where the row
 * doesn't say it already) and the command that makes it usable (the wrapper keeps the tooltip on
 * the disabled switch)
 */
export function ConnectorSwitchTip({ reason, fixCommand, children }: {
  reason?: string;
  fixCommand?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(['settings']);
  if (!reason && !fixCommand) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      {/* Rendered at the top of the page, so the disabled row's fading doesn't show through */}
      <TooltipPrimitive.Portal>
        <TooltipContent className="max-w-xs">
          {reason && <p>{reason}</p>}
          {fixCommand && (
            <>
              <p className={cn(reason && 'mt-1.5')}>{t('settings:mcp.fixHint')}</p>
              <code className="mt-1 block font-mono text-xs">{fixCommand}</code>
            </>
          )}
        </TooltipContent>
      </TooltipPrimitive.Portal>
    </Tooltip>
  );
}
