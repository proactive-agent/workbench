/**
 * The Puppeteer connector's browser profile (Settings > Connectors): Puppeteer's own Chrome or a
 * local profile, in the common dropdown select. The list is the one found when the app started.
 * Profiles that can't be used stay listed, disabled, with the reason as text.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { DEFAULT_BROWSER_VALUE, browserProfileLabel, disabledReasonText, toBrowserChoice } from './browser-profile-meta';
import type { BrowserProfile, PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

interface PuppeteerBrowserSelectProps {
  value: PuppeteerBrowserChoice | undefined;
  onChange: (choice: PuppeteerBrowserChoice | undefined) => void;
}

export function PuppeteerBrowserSelect({ value, onChange }: PuppeteerBrowserSelectProps) {
  const { t } = useTranslation(['settings']);
  const [profiles, setProfiles] = useState<BrowserProfile[] | undefined>(undefined);

  // The list the main process found when the app started (kept in memory: nothing is scanned here)
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.detectBrowserProfiles().then((result) => {
      if (!cancelled && result.success && result.data) setProfiles(result.data);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const list = profiles ?? [];
  // A stored profile that isn't detected any more stays shown (and selected) until changed
  const missing = value && profiles && !list.some((profile) => profile.id === value.id) ? value : undefined;

  const handleChange = (id: string) => {
    if (id === DEFAULT_BROWSER_VALUE) {
      onChange(undefined);
      return;
    }
    if (id === value?.id) return;
    const profile = list.find((p) => p.id === id);
    const choice = profile ? toBrowserChoice(profile) : undefined;
    if (choice) onChange(choice);
  };

  return (
    <Select value={value?.id ?? DEFAULT_BROWSER_VALUE} onValueChange={handleChange}>
      <SelectTrigger aria-label={t('settings:mcp.browserProfile.label')}>
        <SelectValue>
          {value ? browserProfileLabel(t, value) : t('settings:mcp.browserProfile.default')}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_BROWSER_VALUE}>{t('settings:mcp.browserProfile.default')}</SelectItem>
        {missing && (
          <SelectItem value={missing.id}>
            {t('settings:mcp.browserProfile.notFound', { name: browserProfileLabel(t, missing) })}
          </SelectItem>
        )}
        {list.map((profile) => {
          const reason = disabledReasonText(t, profile.disabledReason);
          const detail = reason ?? profile.email;
          return (
            <SelectItem key={profile.id} value={profile.id} disabled={!profile.usable}>
              {browserProfileLabel(t, profile)}
              {detail && <span className="ml-2 text-(--nav-label-color)">{detail}</span>}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
