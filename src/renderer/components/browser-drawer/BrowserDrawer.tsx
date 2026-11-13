import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react';
import {
  useBrowserDrawerStore,
  clampDrawerWidth,
  projectPages,
  projectSessions,
} from '../../stores/browser-drawer-store';
import { useSettingsStore } from '../../stores/settings-store';
import { TITLE_BAR_STRIP_HEIGHT } from '../../lib/title-bar';
import { cn } from '../../lib/utils';
import { AgentLoader } from '../ui/agent-loader';
import { BrowserBookmarksBar } from './BrowserBookmarksBar';
import { BrowserDrawerFrame } from './BrowserDrawerFrame';
import { BrowserExtensionsMenu } from './BrowserExtensionsMenu';
import { BrowserPageView } from './BrowserPageView';
import { ChatBrowserStart } from './ChatBrowserStart';
import { addressToUrl, pageLabel, sessionBrowserIcon } from './browser-drawer-utils';
import type { BrowserShortcut } from '../../../shared/utils/browser-shortcuts';

interface BrowserDrawerProps {
  /** The window's project: its sessions' pages are the drawer's tabs */
  projectId: string;
  /**
   * The Claude chat shown (its conversation, or the New chat page): the drawer shows only that
   * chat's own browser and can open it. Null: every chat browser of the project
   */
  chatId?: string | null;
}

const iconButton = cn(
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground',
  'transition-colors duration-150 hover:bg-nav-hover hover:text-foreground',
  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus) disabled:pointer-events-none disabled:opacity-50'
);

/**
 * The browser drawer at the window's right edge, on the Claude page only: the chat's own headless
 * browser (never a task run's), one tab per page, live and usable, which the user can open there
 * (picking its profile) to work in it with the chat. Closed, it shows nothing: the chat's top bar
 * has the button that opens it again (BrowserDrawerButton); the browsers keep running either way
 */
export function BrowserDrawer({ projectId, chatId = null }: BrowserDrawerProps) {
  const { t } = useTranslation('navigation');
  const open = useBrowserDrawerStore((s) => s.open);
  const state = useBrowserDrawerStore((s) => s.state);
  const selectedPageId = useBrowserDrawerStore((s) => s.selectedPageId);
  const setOpen = useBrowserDrawerStore((s) => s.setOpen);
  const setWidth = useBrowserDrawerStore((s) => s.setWidth);
  const selectPage = useBrowserDrawerStore((s) => s.selectPage);
  const setContext = useBrowserDrawerStore((s) => s.setContext);
  const openNewTab = useBrowserDrawerStore((s) => s.openNewTab);
  const contextReady = useBrowserDrawerStore((s) => s.projectId === projectId && s.chatId === chatId);
  const showBookmarksBar = useSettingsStore((s) => s.settings.browser?.showBookmarksBar !== false);

  // Each chat (and the other pages together) keeps its own view of the drawer
  useLayoutEffect(() => setContext(projectId, chatId), [projectId, chatId, setContext]);

  const [resizing, setResizing] = useState(false);

  const sessions = projectSessions(state.sessions, projectId, chatId);
  const pages = projectPages(state, projectId, chatId);
  const selected = pages.find((page) => page.id === selectedPageId) ?? null;
  const chatBrowser = chatId === null
    ? undefined
    : state.chatBrowsers?.find((browser) => browser.projectId === projectId && browser.chatId === chatId);
  // Where the new tab button opens a tab: the shown tab's browser, else the first one shown
  const newTabSession = selected?.sessionId ?? sessions[0]?.id;

  const [address, setAddress] = useState('');
  const selectedUrl = selected?.url ?? '';
  useEffect(() => setAddress(selectedUrl), [selectedUrl, selected?.id]);

  // A tab that just opened takes the focus: the address bar of one the + button opened, the page of
  // one opened from the drawer's page (a link opened in a new tab). Elsewhere (typing in the chat
  // while Claude opens a tab) the focus stays where it is
  const asideRef = useRef<HTMLElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const pageAreaRef = useRef<HTMLDivElement>(null);
  const focusPageId = useBrowserDrawerStore((s) => s.focusPageId);
  const focusRequestedByUser = useBrowserDrawerStore((s) => s.focusRequestedByUser);
  const clearFocusRequest = useBrowserDrawerStore((s) => s.clearFocusRequest);
  const selectedId = selected?.id;
  // The address bar is focused once it shows the new tab's address, so typing replaces it
  const addressFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusPageId || focusPageId !== selectedId) return;
    clearFocusRequest();
    if (focusRequestedByUser) addressFocusRef.current = focusPageId;
    else if (asideRef.current?.contains(document.activeElement)) pageAreaRef.current?.querySelector('canvas')?.focus();
  }, [focusPageId, focusRequestedByUser, selectedId, clearFocusRequest]);
  useEffect(() => {
    if (!addressFocusRef.current || addressFocusRef.current !== selectedId || address !== selectedUrl) return;
    addressFocusRef.current = null;
    addressRef.current?.focus();
    addressRef.current?.select();
  });

  // An extension's popup shows over the tab it opened for, and closes when another tab shows (as in the browser)
  const popup = selectedId ? state.pages.find((page) => page.popup?.openerId === selectedId) : undefined;
  const stalePopups = state.pages
    .filter((page) => page.popup && page.popup.openerId !== selectedId && pages.some((tab) => tab.sessionId === page.sessionId))
    .map((page) => page.id)
    .join(' ');
  useEffect(() => {
    for (const id of stalePopups.split(' ').filter(Boolean)) window.electronAPI.closeBrowserPage(id);
  }, [stalePopups]);

  // The tab shown stays in sight in a strip of many
  useEffect(() => {
    if (!selectedId) return;
    asideRef.current?.querySelector('[role=tab][aria-selected=true]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);

  // The pages are tracked while the drawer is open
  useEffect(() => {
    if (!open || !state.available) return;
    void window.electronAPI.subscribeBrowserDrawer();
    return () => {
      void window.electronAPI.unsubscribeBrowserDrawer();
    };
  }, [open, state.available]);

  // Closing a chat browser's last tab closes that browser
  const closeTab = (pageId: string, sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    const lastTab = pages.filter((page) => page.sessionId === sessionId).length === 1;
    if (session?.chatId && lastTab) void window.electronAPI.closeChatBrowser(projectId, session.chatId);
    else window.electronAPI.closeBrowserPage(pageId);
  };

  // The browser's own shortcuts (Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+1..9, Ctrl+L, Ctrl+R, Alt+Left...;
  // Cmd on macOS) act on the drawer's tabs while it shows one: its browser is headless, so the
  // main process catches them (before the page and the app's menu) and sends them here
  const shortcutsActive = contextReady && open && !!selected;
  useEffect(() => {
    if (!shortcutsActive) return;
    window.electronAPI.setBrowserShortcuts(true);
    return () => window.electronAPI.setBrowserShortcuts(false);
  }, [shortcutsActive]);
  const onShortcutRef = useRef<(shortcut: BrowserShortcut) => void>(() => undefined);
  onShortcutRef.current = (shortcut) => {
    if (!selected) return;
    const index = pages.findIndex((page) => page.id === selected.id);
    const show = (at: number) => {
      const page = pages[(at + pages.length) % pages.length];
      if (page) selectPage(page.id);
    };
    switch (shortcut.kind) {
      case 'newTab':
        if (newTabSession) openNewTab(newTabSession);
        break;
      case 'closeTab':
        closeTab(selected.id, selected.sessionId);
        break;
      case 'nextTab':
        show(index + 1);
        break;
      case 'previousTab':
        show(index - 1);
        break;
      case 'tab':
        if (shortcut.index < 0) show(pages.length - 1);
        else if (shortcut.index < pages.length) show(shortcut.index);
        break;
      case 'address':
        addressRef.current?.focus();
        addressRef.current?.select();
        break;
      case 'reload':
      case 'back':
      case 'forward':
        window.electronAPI.navigateBrowserPage(selected.id, shortcut.kind);
        break;
    }
  };
  useEffect(() => window.electronAPI.onBrowserShortcut((shortcut) => onShortcutRef.current(shortcut)), []);

  if (!contextReady) return null;

  // Closed: the Claude chat's top bar has the button that opens it (BrowserDrawerButton)
  if (!open) return null;

  // Drag the left edge to resize (the page under the pointer would take the moves, so it ignores
  // the pointer meanwhile)
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    // The width shown (BrowserDrawerFrame): the drawer itself doesn't render again while it is dragged
    const { width, chatMinWidth } = useBrowserDrawerStore.getState();
    const startWidth = clampDrawerWidth(width, window.innerWidth, chatMinWidth);
    setResizing(true);
    // Remembered once the edge is let go
    const onMove = (move: PointerEvent) =>
      setWidth(clampDrawerWidth(startWidth + startX - move.clientX, window.innerWidth, useBrowserDrawerStore.getState().chatMinWidth), false);
    // Let go, or the drag ended without a release (cancelled by the system): the width is kept
    const onUp = () => {
      setResizing(false);
      setWidth(useBrowserDrawerStore.getState().width);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);
  };

  const onSubmitAddress = (event: FormEvent) => {
    event.preventDefault();
    const url = addressToUrl(address);
    if (selected && url) window.electronAPI.navigateBrowserPage(selected.id, 'goto', url);
  };

  const message = (title: string, description?: string, action?: React.ReactNode) => (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <Globe className="h-6 w-6 text-muted-foreground" strokeWidth={1.75} />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-3 flex w-full justify-center">{action}</div>}
    </div>
  );
  const loader = (label: string) => (
    <div className="flex h-full items-center justify-center"><AgentLoader size={24} label={label} /></div>
  );
  // The bridge is connected to every browser shown and none has a tab (an agent closed them all)
  const connected = new Set(state.connectedSessions ?? []);
  const noTabs = sessions.length > 0 && sessions.every((session) => connected.has(session.id));

  let body: React.ReactNode;
  if (!state.available) body = message(t('browserDrawer.unavailable'));
  else if (selected) body = <BrowserPageView pageId={selected.id} label={pageLabel(selected) || t('browserDrawer.untitled')} />;
  else if (noTabs) body = message(t('browserDrawer.noTabs'), t('browserDrawer.noTabsDescription'));
  else if (sessions.length > 0) body = loader(t('browserDrawer.loading'));
  else if (chatBrowser && chatBrowser.status !== 'restorable') {
    body = loader(chatBrowser.status === 'starting' ? t('browserDrawer.opening') : t('browserDrawer.loading'));
  } else if (chatId !== null) {
    // A browser left by a crash opens again from its profile and tabs
    const restorable = chatBrowser?.status === 'restorable' ? { tabs: chatBrowser.tabs ?? 0 } : undefined;
    body = message(
      t('browserDrawer.empty'),
      t('browserDrawer.emptyChatDescription'),
      <ChatBrowserStart projectId={projectId} chatId={chatId} restorable={restorable} />,
    );
  } else body = message(t('browserDrawer.empty'), t('browserDrawer.emptyDescription'));

  return (
    <BrowserDrawerFrame>
      {/* Window drag strip, under the Windows/Linux window controls: the drawer starts below it, level
          with the content area's top (the DEVELOPMENT BUILD strip in development builds) */}
      <div className="electron-drag shrink-0" style={{ height: TITLE_BAR_STRIP_HEIGHT }} />
      <aside ref={asideRef} className="relative flex min-h-0 flex-1 flex-col border-l border-t border-border bg-background">
        {/* Tabs */}
        <div className="flex h-10 shrink-0 items-end gap-1 border-b border-border bg-sidebar pl-2 pr-1.5">
          <div className="flex min-w-0 items-end gap-1 overflow-x-auto" role="tablist" aria-label={t('browserDrawer.title')}>
            {pages.map((page) => {
              const active = page.id === selected?.id;
              const label = pageLabel(page) || t('browserDrawer.untitled');
              // The browser the tab is in, with the icon its profile has in the picker
              const session = sessions.find((s) => s.id === page.sessionId);
              const TabIcon = session ? sessionBrowserIcon(session) : Globe;
              return (
                <div
                  key={page.id}
                  role="tab"
                  aria-selected={active}
                  title={page.url}
                  className={cn(
                    'group flex h-8 min-w-0 max-w-[13rem] shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 pl-2.5 pr-1 text-xs',
                    active
                      ? 'border-border bg-background text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-nav-hover hover:text-foreground'
                  )}
                >
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5" onClick={() => selectPage(page.id)}>
                    <TabIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{label}</span>
                  </button>
                  <button
                    type="button"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-60 hover:bg-nav-hover hover:opacity-100"
                    onClick={() => closeTab(page.id, page.sessionId)}
                    aria-label={t('browserDrawer.closeTab')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
          {/* Beside the tabs, not among them: it stays in sight when they scroll */}
          {newTabSession && (
            <button
              type="button"
              className={cn(iconButton, 'mb-0.5')}
              onClick={() => openNewTab(newTabSession)}
              aria-label={t('browserDrawer.newTab')}
              title={t('browserDrawer.newTab')}
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
          <button
            type="button"
            className={cn(iconButton, 'ml-auto mb-1.5')}
            onClick={() => setOpen(false)}
            aria-label={t('browserDrawer.close')}
            title={t('browserDrawer.close')}
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Toolbar */}
        {selected && (
          <form className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2" onSubmit={onSubmitAddress}>
            <button type="button" className={iconButton} onClick={() => window.electronAPI.navigateBrowserPage(selected.id, 'back')} aria-label={t('browserDrawer.back')} title={t('browserDrawer.back')}>
              <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <button type="button" className={iconButton} onClick={() => window.electronAPI.navigateBrowserPage(selected.id, 'forward')} aria-label={t('browserDrawer.forward')} title={t('browserDrawer.forward')}>
              <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
            </button>
            {/* While the page loads, reload turns into stop */}
            {selected.loading ? (
              <button type="button" className={iconButton} onClick={() => window.electronAPI.navigateBrowserPage(selected.id, 'stop')} aria-label={t('browserDrawer.stop')} title={t('browserDrawer.stop')}>
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            ) : (
              <button type="button" className={iconButton} onClick={() => window.electronAPI.navigateBrowserPage(selected.id, 'reload')} aria-label={t('browserDrawer.reload')} title={t('browserDrawer.reload')}>
                <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            )}
            <input
              ref={addressRef}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onFocus={(event) => event.target.select()}
              aria-label={t('browserDrawer.address')}
              placeholder={t('browserDrawer.addressPlaceholder')}
              spellCheck={false}
              className={cn(
                'ml-1 h-7 min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2.5 text-xs text-foreground',
                'placeholder:text-muted-foreground focus:border-ring focus:outline-none'
              )}
            />
            {sessions.find((session) => session.id === selected.sessionId)?.chatId && (
              <BrowserExtensionsMenu sessionId={selected.sessionId} pageId={selected.id} browserStatus={chatBrowser?.status} />
            )}
          </form>
        )}
        {selected && showBookmarksBar && (
          <BrowserBookmarksBar
            sessionId={selected.sessionId}
            onOpen={(url) => window.electronAPI.navigateBrowserPage(selected.id, 'goto', url)}
          />
        )}

        {/* The page */}
        <div ref={pageAreaRef} className={cn('relative min-h-0 flex-1', resizing && 'pointer-events-none')}>
          {body}
          {/* An extension's popup under its button, at its own size; a click beside it closes it */}
          {popup?.popup && popup.popup.width > 0 && popup.popup.height > 0 && (
            <>
              <div className="absolute inset-0 z-10" aria-hidden onPointerDown={() => window.electronAPI.closeBrowserPage(popup.id)} />
              <div
                className="absolute right-2 top-1 z-20 max-h-[calc(100%-0.5rem)] max-w-[calc(100%-1rem)] overflow-hidden rounded-lg border border-border bg-background shadow-lg"
                style={{ width: popup.popup.width, height: popup.popup.height }}
              >
                <BrowserPageView pageId={popup.id} label={popup.title || t('browserDrawer.extensions')} popup />
              </div>
            </>
          )}
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('browserDrawer.resize')}
          onPointerDown={onResizeStart}
          className={cn(
            'absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize',
            'after:absolute after:inset-y-0 after:left-1 after:w-px after:transition-colors hover:after:bg-primary/40',
            resizing && 'after:bg-primary/40'
          )}
        />
      </aside>
    </BrowserDrawerFrame>
  );
}
