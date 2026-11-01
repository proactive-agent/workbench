import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { useTranslation } from 'react-i18next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Switch } from './ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { McpIcon } from './icons/app-icons';
import { ConnectorSwitchTip } from './settings/ConnectorRow';
import { BUILTIN_CONNECTOR_META, customServerIcon } from './settings/connector-meta';
import { useMcpUnavailableReason } from '../hooks/useMcpAvailability';
import { useSettingsStore } from '../stores/settings-store';
import { getUsableCustomServers } from '../../shared/utils/mcp-connectors';

interface InsightsMcpMenuProps {
  /** Connector ids on for this chat */
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}

/**
 * The chat's MCP servers: every built-in connector and every tested custom server, whether or
 * not it is on in Settings > Connectors (those switches are only the defaults)
 */
export function InsightsMcpMenu({ value, onChange, disabled }: InsightsMcpMenuProps) {
  const { t } = useTranslation(['common', 'settings']);
  const connectors = useSettingsStore((state) => state.settings.mcpConnectors);
  // A server that can't start yet (being prepared, command missing, failing) is off and disabled
  const unavailableReason = useMcpUnavailableReason();

  const servers = [
    ...BUILTIN_CONNECTOR_META.map(({ id, icon }) => ({ id, icon, name: t(`settings:mcp.servers.${id}.name`) })),
    ...getUsableCustomServers(connectors).map((server) => ({ id: server.id, icon: customServerIcon(server), name: server.name })),
  ];
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id));

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={t('common:insights.mcp.label')}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-nav-hover data-[state=open]:text-foreground"
            >
              <McpIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('common:insights.mcp.label')}</TooltipContent>
      </Tooltip>
      {/* Opens below the button; flips above only when it doesn't fit there */}
      <DropdownMenuContent align="start" side="bottom" avoidCollisions className="w-64">
        <DropdownMenuLabel>{t('common:insights.mcp.label')}</DropdownMenuLabel>
        {servers.map(({ id, icon: Icon, name }) => {
          const unavailable = unavailableReason(id);
          const checked = value.includes(id) && !unavailable;
          return (
            <DropdownMenuPrimitive.CheckboxItem
              key={id}
              checked={checked}
              disabled={!!unavailable}
              onCheckedChange={(on) => toggle(id, on)}
              // The menu stays open while servers are switched on and off
              onSelect={(event) => event.preventDefault()}
              className="relative flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground outline-none transition-colors focus:bg-nav-hover data-[disabled]:cursor-default data-[disabled]:opacity-60"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              {/* Why it can't be switched on shows when hovering the switch */}
              <ConnectorSwitchTip reason={unavailable?.tip ?? unavailable?.reason} fixCommand={unavailable?.fixCommand}>
                <Switch checked={checked} disabled={!!unavailable} tabIndex={-1} aria-hidden className="pointer-events-none" />
              </ConnectorSwitchTip>
            </DropdownMenuPrimitive.CheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
