/**
 * The Puppeteer connector's browser profile (Settings > Connectors): Puppeteer's own Chrome or a
 * local profile. Takes the main process's startup detection when it opens, and scans again from
 * scratch on the refresh button. Profiles that can't be used stay listed,
 * disabled, with the reason as text.
 */

import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import {
  DEFAULT_BROWSER_VALUE,
  browserProfileLabel,
  disabledReasonText,
  toBrowserChoice,
} from './browser-profile-meta';
import type { BrowserProfile, PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

interface PuppeteerBrowserSelectProps {
  value: PuppeteerBrowserChoice | undefined;
  onChange: (choice: PuppeteerBrowserChoice | undefined) => void;
}

export function PuppeteerBrowserSelect({ value, onChange }: PuppeteerBrowserSelectProps) {
  const { t } = useTranslation(['settings']);
  const [profiles, setProfiles] = useState<BrowserProfile[] | undefined>(undefined);
  const [detecting, setDetecting] = useState(false);

  const detect = useCallback(async (refresh: boolean) => {
    setDetecting(true);
    try {
      const result = await window.electronAPI.detectBrowserProfiles(refresh);
      if (result.success && result.data) {
        setProfiles(result.data);
      }
    } finally {
      setDetecting(false);
    }
  }, []);

  // The main process's startup detection (kept in memory, so this scans nothing); nothing is
  // stored in the window, so a restart never shows an older list
  useEffect(() => {
    void detect(false);
  }, [detect]);

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
    <div className="flex items-center gap-1">
      <Select value={value?.id ?? DEFAULT_BROWSER_VALUE} onValueChange={handleChange}>
        <SelectTrigger
          className="h-8 w-auto max-w-56 gap-1.5 border-transparent px-2 hover:bg-nav-hover"
          aria-label={t('settings:mcp.browserProfile.label')}
        >
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
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground"
        onClick={() => void detect(true)}
        disabled={detecting}
        title={t('settings:mcp.browserProfile.refresh')}
        aria-label={t('settings:mcp.browserProfile.refresh')}
      >
        <RefreshCw className={cn('h-4 w-4', detecting && 'animate-spin')} strokeWidth={1.75} />
      </Button>
    </div>
  );
}
