import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsRows } from '../settings/SettingsRow';
import { ConnectorRow, ConnectorSwitchTip } from '../settings/ConnectorRow';
import { PuppeteerBrowserSelect } from '../settings/PuppeteerBrowserSelect';
import { BUILTIN_CONNECTOR_META, customServerIcon, customServerSummary, isChromeNotDownloaded } from '../settings/connector-meta';
import { browserProfileIcon, browserProfileLabel } from '../settings/browser-profile-meta';
import { PuppeteerIcon } from '../icons/app-icons';
import { useMcpUnavailableReason } from '../../hooks/useMcpAvailability';
import { getTaskPuppeteerBrowser, getUsableCustomServers } from '../../../shared/utils/mcp-connectors';
import { useSettingsStore } from '../../stores/settings-store';
import type { PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

interface TaskConnectorRowsProps {
  /** Connector ids enabled for this task */
  value: string[];
  onChange?: (value: string[]) => void;
  /**
   * The Puppeteer connector's browser profile picked for this task (null: Puppeteer's own Chrome);
   * undefined follows Settings > Connectors
   */
  puppeteerBrowser?: PuppeteerBrowserChoice | null;
  /** Called when a browser profile is picked for the task; without it no picker is shown */
  onPuppeteerBrowserChange?: (choice: PuppeteerBrowserChoice | null) => void;
  disabled?: boolean;
  /** Shows the task's connectors as they are (the task view): switches can't be changed */
  readOnly?: boolean;
  idPrefix?: string;
}

/** A browser's icon before its name, as in the picker */
const BROWSER_ICON = 'mr-2 inline-block h-4 w-4 align-[-3px]';

/**
 * The task's MCP connectors, like the Connectors settings page: a switch per built-in server and
 * per tested custom server. Starts from the Connectors defaults; changes stay with this task.
 * Every enabled connector is available to the whole Claude Code session. In the form,
 * Puppeteer's row picks the browser profile for the task, starting from the one in Settings.
 * `readOnly` shows the task's own choices (the task view), whatever the servers' state now.
 */
export function TaskConnectorRows({
  value,
  onChange,
  puppeteerBrowser,
  onPuppeteerBrowserChange,
  disabled,
  readOnly = false,
  idPrefix = '',
}: TaskConnectorRowsProps) {
  const { t } = useTranslation(['settings', 'tasks']);
  const connectors = useSettingsStore((state) => state.settings.mcpConnectors);
  // A server that can't start yet (being prepared, command missing, failing) is off and disabled
  const availableReason = useMcpUnavailableReason();
  const unavailableReason = (id: string) => (readOnly ? null : availableReason(id));

  const toggle = (id: string, enabled: boolean) => {
    onChange?.(enabled ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id));
  };

  // The browser the task's Puppeteer uses: its own choice, else the one in Settings
  const browser = getTaskPuppeteerBrowser(puppeteerBrowser, connectors);
  const pickBrowser = (choice: PuppeteerBrowserChoice | undefined) => {
    // The picker taking the Settings profile's detected paths again is no choice of the task's
    if (puppeteerBrowser === undefined && (choice?.id ?? null) === (connectors?.puppeteerBrowser?.id ?? null)) return;
    onPuppeteerBrowserChange?.(choice ?? null);
  };

  const browserControl = (unavailableFix: string | undefined) => {
    if (readOnly) {
      // The task view names the browser only when the task uses Puppeteer
      if (!value.includes('puppeteer')) return null;
      const Icon = browser ? browserProfileIcon(browser) : PuppeteerIcon;
      return (
        <span className="truncate text-sm text-(--nav-label-color)" title={t('settings:mcp.browserProfile.label')}>
          <Icon className={BROWSER_ICON} />
          {browser ? browserProfileLabel(t, browser) : t('settings:mcp.browserProfile.default')}
        </span>
      );
    }
    if (!onPuppeteerBrowserChange) return null;
    // Always there in the form, as on the Connectors page: stays usable while the server is
    // unavailable or off, since another browser can be the fix
    return (
      <PuppeteerBrowserSelect
        value={browser}
        // Availability is checked for the Settings browser: its missing Chrome is this one's only when both are it
        chromeMissing={!browser && !connectors?.puppeteerBrowser && isChromeNotDownloaded(unavailableFix)}
        onChange={pickBrowser}
        disabled={disabled}
      />
    );
  };

  // Read-only switches show a state, not a control the user is kept from
  const switchClass = readOnly ? 'disabled:cursor-default' : undefined;

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
            {id === 'puppeteer' && browserControl(unavailable?.fixCommand)}
            <ConnectorSwitchTip reason={unavailable?.tip} fixCommand={unavailable?.fixCommand}>
              <Switch
                id={`${idPrefix}connector-${id}`}
                checked={value.includes(id) && !unavailable}
                onCheckedChange={(checked) => toggle(id, checked)}
                disabled={readOnly || disabled || !!unavailable}
                className={switchClass}
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
                disabled={readOnly || disabled || !!unavailable}
                className={switchClass}
                aria-label={server.name}
              />
            </ConnectorSwitchTip>
          </ConnectorRow>
        );
      })}
    </SettingsRows>
  );
}
