import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { PlaywrightBrowserSelect } from '../settings/PlaywrightBrowserSelect';
import { isChromiumNotDownloaded } from '../settings/connector-meta';
import { useMcpUnavailableReason } from '../../hooks/useMcpAvailability';
import { useSettingsStore } from '../../stores/settings-store';
import { cn } from '../../lib/utils';
import { useBrowserDrawerStore } from '../../stores/browser-drawer-store';
import { changeChatModelConfig, chatModelConfig, useInsightsStore, withDefaultModelConfig } from '../../stores/insights-store';
import { getDefaultMcpConnectorIds, getTaskPlaywrightBrowser } from '../../../shared/utils/mcp-connectors';
import type { PlaywrightBrowserChoice } from '../../../shared/types/browser-profiles';
import type { ChatBrowserRequirements } from '../../../shared/types/browser-drawer';

interface ChatBrowserStartProps {
  projectId: string;
  /** The chat whose browser opens (its conversation, or the New chat page) */
  chatId: string;
  /** Its browser closed when Workbench stopped unexpectedly: opening it with the same profile brings back its sign-ins and tabs */
  restorable?: { tabs: number };
  /** It was closed with tabs open, which open again with it */
  saved?: { tabs: number };
}

/**
 * The browser profile of the chat's own browser (Settings > Browser' until the chat picks one)
 * and a button that opens it, so the user can sign in or set something up by hand before asking
 * the chat to carry on. Opening switches Playwright on for the chat. Shown only while the chat
 * has no browser: an open browser keeps the profile it opened with. On Windows, while opening that
 * profile needs something that isn't installed (Node.js, Playwright's own browser), Autoconfigure
 * takes Open browser's place: it installs them in a PowerShell window (browser-runtime.ts)
 */
export function ChatBrowserStart({ projectId, chatId, restorable, saved }: ChatBrowserStartProps) {
  const { t } = useTranslation(['navigation']);
  const connectors = useSettingsStore((state) => state.settings.mcpConnectors);
  const session = useInsightsStore((state) => state.session);
  const draftModelConfig = useInsightsStore((state) => state.draftModelConfig);
  const config = chatModelConfig({ session, draftModelConfig });
  const unavailableReason = useMcpUnavailableReason();
  const [opening, setOpening] = useState(false);
  // The last open's error lives in the store: the drawer shows its loader while the browser starts
  const error = useBrowserDrawerStore((state) => state.openErrors[`${projectId}:${chatId}`] ?? null);
  const setOpenError = useBrowserDrawerStore((state) => state.setOpenError);
  const setError = (next: string | null) => setOpenError(projectId, chatId, next);

  const chatChoice = config?.playwrightBrowser;
  const browser = getTaskPlaywrightBrowser(chatChoice, connectors);

  // What opening this profile needs that is missing (Windows; the main process keeps the result
  // until checked again), asked again whenever it says that changed: after Autoconfigure it checks
  // every few seconds, so Open browser comes back as soon as the browser can open
  const [requirements, setRequirements] = useState<ChatBrowserRequirements | null>(null);
  const browserRef = useRef(browser);
  browserRef.current = browser;
  const browserKey = `${browser?.id ?? ''}|${browser?.managed === true}|${browser?.engine ?? ''}`;
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      window.electronAPI.getChatBrowserRequirements?.(browserRef.current).then((result) => {
        if (!cancelled && result.success && result.data) setRequirements(result.data);
      });
    void check();
    const cleanup = window.electronAPI.onChatBrowserRequirementsChanged?.(() => void check());
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [browserKey]);
  const missing = requirements?.missing ?? [];

  const autoconfigure = async () => {
    setError(null);
    const result = await window.electronAPI.autoconfigureChatBrowser(browser).catch((e: unknown) => ({
      success: false as const,
      error: e instanceof Error ? e.message : String(e),
      data: undefined,
    }));
    if (result.success && result.data) setRequirements(result.data);
    else setError(t('navigation:browserDrawer.setup.failed', { error: result.error ?? '' }));
  };

  const missingItems = missing.map((requirement) =>
    requirement === 'node'
      ? t('navigation:browserDrawer.setup.missing.node')
      : t('navigation:browserDrawer.setup.missing.browserBuild', {
          browser: t(`navigation:browserDrawer.setup.browsers.${requirements?.build ?? 'chromium'}`),
        })
  );
  const missingText = missingItems.length > 1
    ? t('navigation:browserDrawer.setup.and', { first: missingItems[0], second: missingItems[1] })
    : missingItems[0];
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
      {!restorable && saved && saved.tabs > 0 && (
        <p className="text-sm text-muted-foreground">{t('navigation:browserDrawer.saved', { count: saved.tabs })}</p>
      )}
      {missingText && (
        // As far from the text above as from the row below (the drawer's empty state sets its action
        // apart from its description, which the first line of it doesn't need)
        <p className={cn('text-center text-xs text-muted-foreground', !restorable && !(saved && saved.tabs > 0) && '-mt-3')}>
          {t('navigation:browserDrawer.setup.description', { items: missingText })}
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
        {missingText ? (
          <Button className="shrink-0 px-3" onClick={() => void autoconfigure()} disabled={requirements?.configuring}>
            {requirements?.configuring ? t('navigation:browserDrawer.setup.installing') : t('navigation:browserDrawer.setup.autoconfigure')}
          </Button>
        ) : (
          <Button className="shrink-0 px-3" onClick={() => void openBrowser()} disabled={opening || !!unavailable}>
            {opening ? t('navigation:browserDrawer.opening') : t('navigation:browserDrawer.openBrowser')}
          </Button>
        )}
      </div>
      {missingText && requirements?.configuring && !error && (
        <p className="text-xs text-muted-foreground">{t('navigation:browserDrawer.setup.configuring')}</p>
      )}
      {(error || (unavailable && !missingText)) && (
        <p className="text-xs text-muted-foreground">
          {error && missingText ? error : error ? t('navigation:browserDrawer.openFailed', { error }) : unavailable?.reason}
        </p>
      )}
    </div>
  );
}
