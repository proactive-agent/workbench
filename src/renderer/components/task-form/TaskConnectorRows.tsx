import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { SettingsRows } from '../settings/SettingsRow';
import { ConnectorRow, ConnectorSwitchTip } from '../settings/ConnectorRow';
import { PlaywrightBrowserSelect } from '../settings/PlaywrightBrowserSelect';
import { BUILTIN_CONNECTOR_META, customServerIcon, customServerSummary, isChromiumNotDownloaded } from '../settings/connector-meta';
import { browserProfileIcon, browserProfileLabel } from '../settings/browser-profile-meta';
import { PlaywrightIcon } from '../icons/app-icons';
import { useMcpUnavailableReason } from '../../hooks/useMcpAvailability';
import { getTaskPlaywrightBrowser, getUsableCustomServers } from '../../../shared/utils/mcp-connectors';
import { useSettingsStore } from '../../stores/settings-store';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';

interface TaskConnectorRowsProps {
  /** Connector ids enabled for this task */
  value: string[];
  onChange?: (value: string[]) => void;
  /**
   * The Playwright connector's browser profile picked for this task (null: Playwright's own Chromium);
   * undefined follows Settings > Connectors
   */
  playwrightBrowser?: PlaywrightBrowserChoice | null;
  /** Called when a browser profile is picked for the task; without it no picker is shown */
  onPlaywrightBrowserChange?: (choice: PlaywrightBrowserChoice | null) => void;
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
 * Playwright's row picks the browser profile for the task, starting from the one in Settings.
 * `readOnly` shows the task's own choices (the task view), whatever the servers' state now.
 */
export function TaskConnectorRows({
  value,
  onChange,
  playwrightBrowser,
  onPlaywrightBrowserChange,
  disabled,
  readOnly = false,
  idPrefix = '',
}: TaskConnectorRowsProps) {
  const { t } = useTranslation(['settings', 'tasks']);
  const connectors = useSettingsStore((state) => state.settings.mcpConnectors);
  // A server that can't start yet (being prepared, command missing, failing) is off and disabled
  // (not in the read-only task view: it shows the task's choices, and asking would start the servers)
  const availableReason = useMcpUnavailableReason({ enabled: !readOnly });
  const unavailableReason = (id: string) => (readOnly ? null : availableReason(id));

  const toggle = (id: string, enabled: boolean) => {
    onChange?.(enabled ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id));
  };

  // The browser the task's Playwright uses: its own choice, else the one in Settings
  const browser = getTaskPlaywrightBrowser(playwrightBrowser, connectors);
  const pickBrowser = (choice: PlaywrightBrowserChoice | undefined) => {
    // The picker taking the Settings profile's detected paths again is no choice of the task's
    if (playwrightBrowser === undefined && (choice?.id ?? null) === (connectors?.playwrightBrowser?.id ?? null)) return;
    onPlaywrightBrowserChange?.(choice ?? null);
  };

  const browserControl = (unavailableFix: string | undefined) => {
    if (readOnly) {
      // The task view names the browser only when the task uses Playwright
      if (!value.includes('playwright')) return null;
      const Icon = browser ? browserProfileIcon(browser) : PlaywrightIcon;
      return (
        <span className="truncate text-sm text-(--nav-label-color)" title={t('settings:mcp.browserProfile.label')}>
          <Icon className={BROWSER_ICON} />
          {browser ? browserProfileLabel(t, browser) : t('settings:mcp.browserProfile.default')}
        </span>
      );
    }
    if (!onPlaywrightBrowserChange) return null;
    // Always there in the form, as on the Connectors page: stays usable while the server is
    // unavailable or off, since another browser can be the fix
    return (
      <PlaywrightBrowserSelect
        value={browser}
        // Availability is checked for the Settings browser: its missing Chrome is this one's only when both are it
        chromiumMissing={!browser && !connectors?.playwrightBrowser && isChromiumNotDownloaded(unavailableFix)}
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
            {id === 'playwright' && browserControl(unavailable?.fixCommand)}
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
