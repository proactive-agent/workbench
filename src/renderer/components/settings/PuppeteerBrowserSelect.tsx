/**
 * The Puppeteer connector's browser profile (Settings > Connectors): Puppeteer's own Chrome or a
 * local profile, in the common dropdown select. The list is the one found when the app started.
 * Profiles that can't be used stay listed, disabled, with the reason as text. Browsers Puppeteer can
 * download (Firefox, and its Chrome when the build its server needs is missing) have a download
 * button next to them that opens a terminal running the install; the button sits beside the item,
 * not in it, because a disabled item ignores clicks. The list updates when the download finishes.
 */

import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  DEFAULT_BROWSER_VALUE,
  MISSING_BROWSER_VALUE,
  browserProfileIcon,
  browserProfileLabel,
  disabledReasonText,
  refreshedBrowserChoice,
  storedChoiceProfile,
  toBrowserChoice,
} from './browser-profile-meta';
import { PuppeteerIcon } from '../icons/app-icons';
import type { BrowserProfile, DownloadableBrowser, PuppeteerBrowserChoice } from '../../../shared/types/browser-profiles';

interface PuppeteerBrowserSelectProps {
  value: PuppeteerBrowserChoice | undefined;
  onChange: (choice: PuppeteerBrowserChoice | undefined) => void;
  /** Puppeteer's own Chrome can't start because its build isn't downloaded: the default item offers the download */
  chromeMissing?: boolean;
}

/** A download button beside a dropdown item */
/** A browser's icon before its name in the list */
const ITEM_ICON = 'mr-2 inline-block h-4 w-4 align-[-3px]';

function DownloadButton({ browser, onDownload, besideCheck = false }: {
  browser: DownloadableBrowser;
  onDownload: (browser: DownloadableBrowser) => void;
  /** The item can be selected, so its check needs the right edge: the button sits left of it */
  besideCheck?: boolean;
}) {
  const { t } = useTranslation(['settings']);
  const name = t(`settings:mcp.browserProfile.browsers.${browser}`);
  const label = `${t('settings:mcp.browserProfile.download', { browser: name })}. ${t('settings:mcp.browserProfile.downloadDescription')}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // The dropdown reacts to pointer events on its content: keep the click for this button
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onDownload(browser);
      }}
      className={cn(
        // Where the check of a selected item shows (a disabled item is never selected)
        'absolute top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-nav-hover hover:text-foreground',
        besideCheck ? 'right-9' : 'right-2.5'
      )}
    >
      <Download className="h-4 w-4" strokeWidth={1.75} />
    </button>
  );
}

export function PuppeteerBrowserSelect({ value, onChange, chromeMissing = false }: PuppeteerBrowserSelectProps) {
  const { t } = useTranslation(['settings']);
  const [profiles, setProfiles] = useState<BrowserProfile[] | undefined>(undefined);

  // The list the main process found when the app started (kept in memory: nothing is scanned here)
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.detectBrowserProfiles().then((result) => {
      if (!cancelled && result.success && result.data) setProfiles(result.data);
    }).catch(() => undefined);
    // A download started from here finished: the main process found the new browser
    const stopListening = window.electronAPI.onBrowserProfilesChanged((next) => setProfiles(next));
    return () => {
      cancelled = true;
      stopListening();
    };
  }, []);

  // The stored choice is a copy of the profile's paths: take the detected ones when they changed
  // (once per stored value and list: the parent's onChange changes every render)
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const refreshed = refreshedBrowserChoice(value, profiles);
    if (refreshed) onChangeRef.current(refreshed);
  }, [value, profiles]);

  // A download that couldn't start (npx missing, no terminal): said at the top of the list
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const download = (browser: DownloadableBrowser) => {
    setDownloadError(null);
    void window.electronAPI.installPuppeteerBrowser(browser)
      .then((result) => {
        if (!result.success) setDownloadError(result.error ?? t('settings:mcp.browserProfile.downloadFailed'));
      })
      .catch(() => setDownloadError(t('settings:mcp.browserProfile.downloadFailed')));
  };

  // Puppeteer's own downloads first, then the browsers found on this computer
  const list = [...(profiles ?? [])].sort((a, b) => Number(!!b.managed) - Number(!!a.managed));
  // A stored profile that isn't detected any more stays shown (and selected) until changed. A
  // detected profile with its id but from another install (after a shell runtime switch) isn't it
  const missing = value && profiles && !storedChoiceProfile(value, list) ? value : undefined;
  const selected = missing ? MISSING_BROWSER_VALUE : value?.id ?? DEFAULT_BROWSER_VALUE;

  const handleChange = (id: string) => {
    if (id === DEFAULT_BROWSER_VALUE) {
      onChange(undefined);
      return;
    }
    if (id === MISSING_BROWSER_VALUE) return;
    if (id === value?.id && !missing) {
      refreshSelected();
      return;
    }
    const profile = list.find((p) => p.id === id);
    const choice = profile ? toBrowserChoice(profile) : undefined;
    if (choice) onChange(choice);
  };

  // Picking the selected item again (the dropdown reports no change) takes its detected paths
  const refreshSelected = () => {
    const refreshed = refreshedBrowserChoice(value, profiles);
    if (refreshed) onChange(refreshed);
  };

  // The chosen browser's icon in the closed picker too
  const SelectedIcon = value ? browserProfileIcon(value) : PuppeteerIcon;

  return (
    <Select value={selected} onValueChange={handleChange}>
      <SelectTrigger aria-label={t('settings:mcp.browserProfile.label')}>
        <SelectValue>
          <SelectedIcon className={ITEM_ICON} />
          {missing
            ? t('settings:mcp.browserProfile.notFound', { name: browserProfileLabel(t, missing) })
            : value ? browserProfileLabel(t, value) : t('settings:mcp.browserProfile.default')}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {downloadError && <p className="px-3 py-2 text-xs text-destructive">{downloadError}</p>}
        <div className="relative">
          <SelectItem value={DEFAULT_BROWSER_VALUE} className={chromeMissing ? 'pr-16' : undefined}>
            <PuppeteerIcon className={ITEM_ICON} />
            {t('settings:mcp.browserProfile.default')}
            {chromeMissing && <span className="ml-2 text-(--nav-label-color)">{t('settings:mcp.browserProfile.reasons.notDownloaded')}</span>}
          </SelectItem>
          {chromeMissing && <DownloadButton browser="chrome" onDownload={download} besideCheck />}
        </div>
        {missing && (
          <SelectItem value={MISSING_BROWSER_VALUE}>
            {t('settings:mcp.browserProfile.notFound', { name: browserProfileLabel(t, missing) })}
          </SelectItem>
        )}
        {list.map((profile) => {
          const reason = disabledReasonText(t, profile.disabledReason);
          const detail = reason ?? profile.email;
          const Icon = browserProfileIcon(profile);
          return (
            <div key={profile.id} className="relative">
              <SelectItem
                value={profile.id}
                disabled={!profile.usable}
                {...(profile.id === value?.id && !missing ? {
                  onPointerUp: refreshSelected,
                  onKeyDown: (event: React.KeyboardEvent) => {
                    if (event.key === 'Enter' || event.key === ' ') refreshSelected();
                  },
                } : {})}
              >
                <Icon className={ITEM_ICON} />
                {browserProfileLabel(t, profile)}
                {detail && <span className="ml-2 text-(--nav-label-color)">{detail}</span>}
              </SelectItem>
              {profile.downloadable && <DownloadButton browser={profile.downloadable} onDownload={download} />}
            </div>
          );
        })}
      </SelectContent>
    </Select>
  );
}
