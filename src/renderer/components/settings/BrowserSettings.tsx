/**
 * Browser (app settings): the chat browsers shown in the browser drawer. The default profile (which
 * task runs and chats use unless they pick another) is kept with the connector defaults
 * (McpConnectorSettings.playwrightBrowser); tasks still pick their own on the Playwright row.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { Input } from '../ui/input';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { PlaywrightBrowserSelect } from './PlaywrightBrowserSelect';
import { isChromiumNotDownloaded } from './connector-meta';
import { useMcpUnavailableReason } from '../../hooks/useMcpAvailability';
import { addressToUrl } from '../browser-drawer/browser-drawer-utils';
import type { AppSettings, BrowserSettings as BrowserSettingsValues } from '../../../shared/types';

interface BrowserSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

export function BrowserSettings({ settings, onSettingsChange }: BrowserSettingsProps) {
  const { t } = useTranslation('settings');
  const connectors = settings.mcpConnectors ?? {};
  const browser = settings.browser ?? {};
  const unavailable = useMcpUnavailableReason()('playwright');

  const updateBrowser = (patch: Partial<BrowserSettingsValues>) => onSettingsChange({ ...settings, browser: { ...browser, ...patch } });

  // The homepage is saved as an address once typed (example.com becomes https://example.com)
  const [homepage, setHomepage] = useState(browser.homepage ?? '');
  useEffect(() => setHomepage(browser.homepage ?? ''), [browser.homepage]);
  const saveHomepage = () => {
    const url = addressToUrl(homepage) ?? '';
    setHomepage(url);
    if (url !== (browser.homepage ?? '')) updateBrowser({ homepage: url || undefined });
  };

  return (
    <SettingsSection title={t('sections.browser.title')}>
      <SettingsRows>
        <SettingsRow label={t('browser.profile')} description={t('browser.profileDescription')}>
          <PlaywrightBrowserSelect
            value={connectors.playwrightBrowser}
            // Playwright's own Chromium failed for a build that isn't downloaded
            chromiumMissing={!connectors.playwrightBrowser && isChromiumNotDownloaded(unavailable?.fixCommand)}
            onChange={(choice) => {
              const { playwrightBrowser: _previous, ...rest } = connectors;
              onSettingsChange({ ...settings, mcpConnectors: choice ? { ...rest, playwrightBrowser: choice } : rest });
            }}
          />
        </SettingsRow>
        <SettingsRow label={t('browser.homepage')} description={t('browser.homepageDescription')} htmlFor="browserHomepage">
          <Input
            id="browserHomepage"
            className="w-64"
            value={homepage}
            placeholder={t('browser.homepagePlaceholder')}
            spellCheck={false}
            onChange={(event) => setHomepage(event.target.value)}
            onBlur={saveHomepage}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveHomepage();
            }}
          />
        </SettingsRow>
        <SettingsRow label={t('browser.bookmarksBar')} description={t('browser.bookmarksBarDescription')}>
          <Switch
            checked={browser.showBookmarksBar !== false}
            onCheckedChange={(showBookmarksBar) => updateBrowser({ showBookmarksBar })}
            aria-label={t('browser.bookmarksBar')}
          />
        </SettingsRow>
        <SettingsRow label={t('browser.extensions')} description={t('browser.extensionsDescription')}>
          <Switch
            checked={browser.extensions === true}
            onCheckedChange={(extensions) => updateBrowser({ extensions })}
            aria-label={t('browser.extensions')}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
