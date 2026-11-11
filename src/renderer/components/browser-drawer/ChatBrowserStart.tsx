import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { PlaywrightBrowserSelect } from '../settings/PlaywrightBrowserSelect';
import { isChromiumNotDownloaded } from '../settings/connector-meta';
import { useMcpUnavailableReason } from '../../hooks/useMcpAvailability';
import { useSettingsStore } from '../../stores/settings-store';
import { changeChatModelConfig, chatModelConfig, useInsightsStore, withDefaultModelConfig } from '../../stores/insights-store';
import { getDefaultMcpConnectorIds, getTaskPlaywrightBrowser } from '../../../shared/utils/mcp-connectors';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';

interface ChatBrowserStartProps {
  projectId: string;
  /** The chat whose browser opens (its conversation, or the New chat page) */
  chatId: string;
  /** Its browser closed when Workbench stopped unexpectedly: opening it with the same profile brings back its sign-ins and tabs */
  restorable?: { tabs: number };
}

/**
 * The browser profile of the chat's own browser (Settings > Browser' until the chat picks one)
 * and a button that opens it, so the user can sign in or set something up by hand before asking
 * the chat to carry on. Opening switches Playwright on for the chat. Shown only while the chat
 * has no browser: an open browser keeps the profile it opened with
 */
export function ChatBrowserStart({ projectId, chatId, restorable }: ChatBrowserStartProps) {
  const { t } = useTranslation(['navigation']);
  const connectors = useSettingsStore((state) => state.settings.mcpConnectors);
  const session = useInsightsStore((state) => state.session);
  const draftModelConfig = useInsightsStore((state) => state.draftModelConfig);
  const config = chatModelConfig({ session, draftModelConfig });
  const unavailableReason = useMcpUnavailableReason();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chatChoice = config?.playwrightBrowser;
  const browser = getTaskPlaywrightBrowser(chatChoice, connectors);
  // Availability is checked for the Settings browser: it says something about this one only when the chat follows Settings
  const unavailable = chatChoice === undefined ? unavailableReason('playwright') : null;

  const pickBrowser = (choice: PlaywrightBrowserChoice | undefined) => {
    setError(null);
    // The picker taking the Settings profile's detected paths again is no choice of the chat's
    if (chatChoice === undefined && (choice?.id ?? null) === (connectors?.playwrightBrowser?.id ?? null)) return;
    void changeChatModelConfig(projectId, { ...withDefaultModelConfig(config), playwrightBrowser: choice ?? null });
  };

  const openBrowser = async () => {
    setOpening(true);
    setError(null);
    // The chat's Playwright works in this browser: switched on for the chat when it was off
    const ids = config?.mcpConnectors ?? getDefaultMcpConnectorIds(connectors);
    if (!ids.includes('playwright')) {
      await changeChatModelConfig(projectId, { ...withDefaultModelConfig(config), mcpConnectors: [...ids, 'playwright'] });
    }
    const result = await window.electronAPI.openChatBrowser(projectId, chatId, chatChoice).catch((e: unknown) => ({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }));
    setOpening(false);
    if (!result.success) setError(result.error ?? t('navigation:browserDrawer.openFailedUnknown'));
  };

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-2">
      {restorable && (
        <p className="text-sm text-muted-foreground">
          {restorable.tabs > 0
            ? t('navigation:browserDrawer.restorable', { count: restorable.tabs })
            : t('navigation:browserDrawer.restorableNoTabs')}
        </p>
      )}
      <div className="flex w-full items-center gap-2">
        <div className="min-w-0 flex-1">
          <PlaywrightBrowserSelect
            value={browser}
            chromiumMissing={!browser && !connectors?.playwrightBrowser && isChromiumNotDownloaded(unavailable?.fixCommand)}
            onChange={pickBrowser}
            disabled={opening}
          />
        </div>
        <Button className="shrink-0 px-3" onClick={() => void openBrowser()} disabled={opening || !!unavailable}>
          {opening ? t('navigation:browserDrawer.opening') : t('navigation:browserDrawer.openBrowser')}
        </Button>
      </div>
      {(error || unavailable) && (
        <p className="text-xs text-muted-foreground">
          {error ? t('navigation:browserDrawer.openFailed', { error }) : unavailable?.reason}
        </p>
      )}
    </div>
  );
}
