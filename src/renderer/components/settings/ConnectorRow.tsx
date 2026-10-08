import { Brain, Globe, Monitor, Search, Terminal } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { CustomMcpServer } from '../../../shared/types';

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
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** Built-in connectors that can be switched on or off: icon and translation keys (settings ns) */
export const BUILTIN_CONNECTOR_META: { id: 'context7' | 'memory' | 'electron' | 'puppeteer'; icon: React.ElementType; qaOnly?: boolean }[] = [
  { id: 'context7', icon: Search },
  { id: 'memory', icon: Brain },
  { id: 'electron', icon: Monitor, qaOnly: true },
  { id: 'puppeteer', icon: Globe, qaOnly: true },
];

/** Icon for a custom server (command or HTTP) */
export function customServerIcon(server: CustomMcpServer): React.ElementType {
  return server.type === 'command' ? Terminal : Globe;
}

/** A custom server's own description, otherwise its command or URL */
export function customServerSummary(server: CustomMcpServer): string {
  return server.description?.trim()
    || (server.type === 'command' ? `${server.command} ${server.args?.join(' ') || ''}`.trim() : server.url || '');
}
