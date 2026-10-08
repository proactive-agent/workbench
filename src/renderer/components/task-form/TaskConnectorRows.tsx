import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsRows } from '../settings/SettingsRow';
import { BUILTIN_CONNECTOR_META, ConnectorRow, customServerIcon, customServerSummary } from '../settings/ConnectorRow';
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
 */
export function TaskConnectorRows({ value, onChange, disabled, idPrefix = '' }: TaskConnectorRowsProps) {
  const { t } = useTranslation(['settings', 'tasks']);
  const connectors = useSettingsStore((state) => state.settings.mcpConnectors);

  const toggle = (id: string, enabled: boolean) => {
    onChange(enabled ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id));
  };

  return (
    <div className="pt-3">
      <div className="text-sm text-(--nav-label-color)">{t('tasks:form.connectorsLabel')}</div>
      <SettingsRows>
        {BUILTIN_CONNECTOR_META.map(({ id, icon, qaOnly }) => {
          const name = t(`settings:mcp.servers.${id}.name`);
          const description = t(`settings:mcp.servers.${id}.description`);
          return (
            <ConnectorRow
              key={id}
              icon={icon}
              name={name}
              description={qaOnly ? `${description} (${t('settings:mcp.qaAgentsOnly')})` : description}
            >
              <Switch
                id={`${idPrefix}connector-${id}`}
                checked={value.includes(id)}
                onCheckedChange={(checked) => toggle(id, checked)}
                disabled={disabled}
                aria-label={name}
              />
            </ConnectorRow>
          );
        })}
        {getUsableCustomServers(connectors).map((server) => (
          <ConnectorRow key={server.id} icon={customServerIcon(server)} name={server.name} description={customServerSummary(server)}>
            <Switch
              id={`${idPrefix}connector-${server.id}`}
              checked={value.includes(server.id)}
              onCheckedChange={(checked) => toggle(server.id, checked)}
              disabled={disabled}
              aria-label={server.name}
            />
          </ConnectorRow>
        ))}
      </SettingsRows>
    </div>
  );
}
