import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCw } from 'lucide-react';
import { ExtensionsIcon } from '../icons/app-icons';
import type { BrowserExtension } from '../../../shared/types/browser-drawer';
import { noteDrawerInput, useBrowserDrawerStore } from '../../stores/browser-drawer-store';
import { cn } from '../../lib/utils';
import { Switch } from '../ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

interface BrowserExtensionsMenuProps {
  /** The chat browser whose profile's extensions show */
  sessionId: string;
  /** The tab shown: an extension opened from here acts on it, as from the browser's own toolbar */
  pageId: string;
  /** Changes when the chat's browser opens or starts again: its extensions are read again */
  browserStatus?: string;
  /** The extension popup shown over the tab, if one is: its button closes it again */
  popup?: { id: string; extensionId: string };
}

const buttonClass = cn(
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground',
  'transition-colors duration-150 hover:bg-nav-hover hover:text-foreground data-[state=open]:bg-nav-hover',
  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)'
);

function ExtensionIcon({ extension, className }: { extension: BrowserExtension; className?: string }) {
  if (extension.icon) return <img src={extension.icon} alt="" draggable={false} className={cn('object-contain', className)} />;
  return <ExtensionsIcon className={cn('text-muted-foreground', className)} />;
}

/** An extension's switch, which alone turns it on or off (a click elsewhere on its row opens it) */
function ExtensionSwitch({ extension, label, onSwitch }: { extension: BrowserExtension; label: string; onSwitch: () => void }) {
  return (
    <Switch
      size="sm"
      checked={extension.enabled}
      aria-label={label}
      className="shrink-0"
      // Kept from the row: its click would open the extension and close the menu
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onSwitch();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    />
  );
}

/** Tells one extension's ask for its popup from the next */
let openingToken = 0;
/** How long a popup the browser opened may take to be listed before its loading box goes */
const POPUP_LISTED_WAIT_MS = 3000;

/**
 * The browser's extensions beside the address bar, as in the browser's own toolbar (the drawer's
 * browsers are headless): the pinned ones that run, then a button listing the others. Clicking one
 * opens its popup or runs its action for the tab shown, as the browser's button does (Firefox: its
 * popup's page, mouse only, else its homepage);
 * only its switch turns it on or off (a pinned one's is in its right-click menu). Shown only for a
 * chat browser that runs its profile's extensions (Settings > Browser)
 */
export function BrowserExtensionsMenu({ sessionId, pageId, browserStatus, popup }: BrowserExtensionsMenuProps) {
  const { t } = useTranslation('navigation');
  const info = useBrowserDrawerStore((s) => s.extensions[sessionId]);
  const loadExtensions = useBrowserDrawerStore((s) => s.loadExtensions);
  const switchExtension = useBrowserDrawerStore((s) => s.switchExtension);
  const [open, setOpen] = useState(false);
  /** The pinned extension whose right-click menu is open */
  const [pinnedMenu, setPinnedMenu] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => loadExtensions(sessionId), [sessionId, browserStatus, loadExtensions]);

  // The menu button goes once it would list nothing: its menu closes with it (else it would open
  // again on its own when something is listed again)
  const menuShown = !!info && info.extensions.some((extension) => !(extension.pinned && extension.enabled) || info.restartToApply);
  useEffect(() => {
    if (!menuShown && open) setOpen(false);
  }, [menuShown, open]);

  if (!info || info.extensions.length === 0) return null;
  // The browser's toolbar shows the pinned ones that run; the menu lists the rest
  const inToolbar = (extension: BrowserExtension) => extension.pinned && extension.enabled;
  const pinned = info.extensions.filter(inToolbar);
  const listed = info.extensions.filter((extension) => !inToolbar(extension));
  const canOpen = info.canOpen === true;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Switched in the browser meanwhile (Claude, or a page): read again
    if (next) loadExtensions(sessionId);
  };

  /** What its toolbar button does: its popup opens (shown over the page), or its action runs */
  const openExtension = (extension: BrowserExtension) => {
    // Its popup shown: the button closes it, as the browser's does
    if (popup?.extensionId === extension.id) {
      window.electronAPI.closeBrowserPage(popup.id);
      return;
    }
    if (!canOpen || !extension.enabled) return;
    // A tab the extension opens is the user's: shown, as one opened from the page would be
    noteDrawerInput(pageId);
    // Its popup's box shows at once, loading, until the popup is there (BrowserDrawer)
    const token = ++openingToken;
    const store = useBrowserDrawerStore.getState();
    store.setExtensionOpening({ token, openerId: pageId, extensionId: extension.id });
    void window.electronAPI.runBrowserExtension(pageId, extension.id, extension.name).then(
      (result) => {
        const current = useBrowserDrawerStore.getState().extensionOpening;
        const popupId = result.success ? result.data?.popupId : undefined;
        // Given up meanwhile (a click beside it, another one asked for): a popup that came anyway goes
        if (current?.token !== token) {
          if (popupId && current?.extensionId !== extension.id) window.electronAPI.closeBrowserPage(popupId);
          return;
        }
        const done = () => {
          if (useBrowserDrawerStore.getState().extensionOpening?.token === token) useBrowserDrawerStore.getState().setExtensionOpening(null);
        };
        // No popup (its action ran, or its homepage opened): nothing more to wait for. A popup's own
        // box takes over once that popup is listed (BrowserDrawer), a moment later
        if (popupId) {
          useBrowserDrawerStore.getState().setExtensionOpening({ ...current, popupId });
          setTimeout(done, POPUP_LISTED_WAIT_MS);
        } else done();
      },
      () => {
        if (useBrowserDrawerStore.getState().extensionOpening?.token === token) useBrowserDrawerStore.getState().setExtensionOpening(null);
      }
    );
  };

  const switchLabel = (extension: BrowserExtension) => t('browserDrawer.extensionSwitch', { name: extension.name });
  const toggle = (extension: BrowserExtension) => void switchExtension(sessionId, extension.id, !extension.enabled);

  const restart = () => {
    setRestarting(true);
    void window.electronAPI.restartChatBrowser(sessionId).finally(() => setRestarting(false));
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={t('browserDrawer.extensions')}>
      {pinned.map((extension) => (
        <DropdownMenu
          key={extension.id}
          open={pinnedMenu === extension.id}
          onOpenChange={(next) => setPinnedMenu(next ? extension.id : null)}
        >
          <DropdownMenuTrigger
            className={buttonClass}
            title={extension.name}
            aria-label={extension.name}
            // Not a click beside the popup (BrowserDrawer): this one toggles it, another replaces it
            data-extension-button=""
            // A click opens the extension; the right-click menu has its switch
            onPointerDown={(event) => {
              if (event.button === 0) event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openExtension(extension);
              }
            }}
            onClick={() => openExtension(extension)}
            onContextMenu={(event) => {
              event.preventDefault();
              setPinnedMenu(extension.id);
            }}
          >
            <ExtensionIcon extension={extension} className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
              <ExtensionIcon extension={extension} className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{extension.name}</span>
              <ExtensionSwitch extension={extension} label={switchLabel(extension)} onSwitch={() => toggle(extension)} />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      {/* Hidden while it would list nothing (every extension pinned), unless a restart waits there */}
      {(listed.length > 0 || info.restartToApply) && (
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger className={buttonClass} title={t('browserDrawer.extensions')} aria-label={t('browserDrawer.extensions')}>
          <ExtensionsIcon className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[70vh] w-72 overflow-y-auto">
          <DropdownMenuLabel className="text-xs">{t('browserDrawer.extensions')}</DropdownMenuLabel>
          {listed.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('browserDrawer.extensionsAllPinned')}</p>
          )}
          {listed.map((extension) => (
            <DropdownMenuItem
              key={extension.id}
              data-extension-button=""
              className="gap-2 py-1.5 text-xs"
              onSelect={(event) => {
                // Nothing to open: the list stays
                if (!canOpen || !extension.enabled) {
                  event.preventDefault();
                  return;
                }
                openExtension(extension);
              }}
            >
              <ExtensionIcon extension={extension} className={cn('h-4 w-4 shrink-0', !extension.enabled && 'opacity-50')} />
              <span className={cn('min-w-0 flex-1 truncate', !extension.enabled && 'text-muted-foreground')}>{extension.name}</span>
              <ExtensionSwitch extension={extension} label={switchLabel(extension)} onSwitch={() => toggle(extension)} />
            </DropdownMenuItem>
          ))}
          {info.restartToApply && (
            <>
              <DropdownMenuSeparator />
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('browserDrawer.extensionsRestartNote')}</p>
              <DropdownMenuItem className="gap-2 py-1.5 text-xs" disabled={restarting} onSelect={restart}>
                <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t('browserDrawer.restartBrowser')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      )}
    </div>
  );
}
