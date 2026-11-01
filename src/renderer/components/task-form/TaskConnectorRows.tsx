import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsRows } from '../settings/SettingsRow';
import { ConnectorRow, ConnectorSwitchTip } from '../settings/ConnectorRow';
import { BUILTIN_CONNECTOR_META, customServerIcon, customServerSummary } from '../settings/connector-meta';
import { useMcpUnavailableReason } from '../../hooks/useMcpAvailability';
import { getUsableCustomServers } from '../../../shared/utils/mcp-connectors';
import { useSettingsStore } from '../../stores/settings-store';

interface TaskConnectorRowsProps {
  /** Connector ids enabled for this task */
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  idPrefix?: string;
}

/**
 * The task's MCP connectors, like the Connectors settings page: a switch per built-in server and
 * per tested custom server. Starts from the Connectors defaults; changes stay with this task.
 * Every enabled connector is available to the whole Claude Code session.
 */
export function TaskConnectorRows({ value, onChange, disabled, idPrefix = '' }: TaskConnectorRowsProps) {
  const { t } = useTranslation(['settings', 'tasks']);
  const connectors = useSettingsStore((state) => state.settings.mcpConnectors);
  // A server that can't start yet (being prepared, command missing, failing) is off and disabled
  const unavailableReason = useMcpUnavailableReason();

  const toggle = (id: string, enabled: boolean) => {
    onChange(enabled ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id));
  };

  return (
    <SettingsRows>
      {BUILTIN_CONNECTOR_META.map(({ id, icon }) => {
        const name = t(`settings:mcp.servers.${id}.name`);
        const unavailable = unavailableReason(id);
        const description = unavailable?.reason ?? t(`settings:mcp.servers.${id}.description`);
        return (
          <ConnectorRow
            key={id}
            icon={icon}
            name={name}
            description={description}
            disabled={!!unavailable}
          >
            <ConnectorSwitchTip reason={unavailable?.tip} fixCommand={unavailable?.fixCommand}>
              <Switch
                id={`${idPrefix}connector-${id}`}
                checked={value.includes(id) && !unavailable}
                onCheckedChange={(checked) => toggle(id, checked)}
                disabled={disabled || !!unavailable}
                aria-label={name}
              />
            </ConnectorSwitchTip>
          </ConnectorRow>
        );
      })}
      {getUsableCustomServers(connectors).map((server) => {
        const unavailable = unavailableReason(server.id);
        return (
          <ConnectorRow
            key={server.id}
            icon={customServerIcon(server)}
            name={server.name}
            description={unavailable?.reason ?? customServerSummary(server)}
            disabled={!!unavailable}
          >
            <ConnectorSwitchTip fixCommand={unavailable?.fixCommand}>
              <Switch
                id={`${idPrefix}connector-${server.id}`}
                checked={value.includes(server.id) && !unavailable}
                onCheckedChange={(checked) => toggle(server.id, checked)}
                disabled={disabled || !!unavailable}
                aria-label={server.name}
              />
            </ConnectorSwitchTip>
          </ConnectorRow>
        );
      })}
    </SettingsRows>
  );
}
