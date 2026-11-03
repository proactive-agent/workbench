import { useEffect, useLayoutEffect, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react';
import {
  useBrowserDrawerStore,
  clampDrawerWidth,
  projectPages,
  projectSessions,
} from '../../stores/browser-drawer-store';
import { TITLE_BAR_STRIP_HEIGHT } from '../../lib/title-bar';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { AgentLoader } from '../ui/agent-loader';
import { BrowserPageView } from './BrowserPageView';
import { ChatBrowserStart } from './ChatBrowserStart';
import { addressToUrl, pageLabel, sessionBrowserIcon } from './browser-drawer-utils';

interface BrowserDrawerProps {
  /** The window's project: its sessions' pages are the drawer's tabs */
  projectId: string;
  /** Closed, leave a handle on the window's edge that opens it (pages without their own button) */
  showHandle?: boolean;
  /**
   * The Claude chat shown (its conversation, or the New chat page): the drawer shows only that
   * chat's own browser and can open it. Null on the other pages: every browser of the project
   */
  chatId?: string | null;
}

const iconButton = cn(
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground',
  'transition-colors duration-150 hover:bg-nav-hover hover:text-foreground',
  'focus-visible:outline-none focus-visible:shadow-(--shadow-focus) disabled:pointer-events-none disabled:opacity-50'
);

/**
 * The browser drawer at the window's right edge: the headless browsers the project's task runs
 * and chats open, one tab per page, live and usable. Closed, it leaves a handle on the edge that
 * opens it again; the browsers keep running either way. On the Claude page it shows the chat's
 * own browser, which the user can open there (picking its profile) to work in it with the chat
 */
export function BrowserDrawer({ projectId, showHandle = true, chatId = null }: BrowserDrawerProps) {
  const { t } = useTranslation('navigation');
  const open = useBrowserDrawerStore((s) => s.open);
  const width = useBrowserDrawerStore((s) => s.width);
  const state = useBrowserDrawerStore((s) => s.state);
  const selectedPageId = useBrowserDrawerStore((s) => s.selectedPageId);
  const setOpen = useBrowserDrawerStore((s) => s.setOpen);
  const setWidth = useBrowserDrawerStore((s) => s.setWidth);
  const selectPage = useBrowserDrawerStore((s) => s.selectPage);
  const setContext = useBrowserDrawerStore((s) => s.setContext);
  const openNewTab = useBrowserDrawerStore((s) => s.openNewTab);
  const contextReady = useBrowserDrawerStore((s) => s.projectId === projectId && s.chatId === chatId);

  // Each chat (and the other pages together) keeps its own view of the drawer
  useLayoutEffect(() => setContext(projectId, chatId), [projectId, chatId, setContext]);

  const [resizing, setResizing] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);

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

  // The pages are tracked while the drawer is open
  useEffect(() => {
    if (!open || !state.available) return;
    void window.electronAPI.subscribeBrowserDrawer();
    return () => {
      void window.electronAPI.unsubscribeBrowserDrawer();
    };
  }, [open, state.available]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  if (!contextReady) return null;

  if (!open) {
    if (!showHandle) return null;
    const label = sessions.length > 0 ? t('browserDrawer.openWithSessions', { count: sessions.length }) : t('browserDrawer.open');
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={label}
            className={cn(
              'fixed right-0 top-1/2 z-40 flex h-14 w-5 -translate-y-1/2 items-center justify-center',
              'rounded-l-md border border-r-0 border-border bg-card text-muted-foreground shadow-sm',
              'transition-[width,color] duration-150 hover:w-6 hover:text-foreground focus-visible:outline-none focus-visible:shadow-(--shadow-focus)'
            )}
          >
            <Globe className="h-3.5 w-3.5" strokeWidth={1.75} />
            {sessions.length > 0 && <span className="absolute left-1 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
    );
  }

  const drawerWidth = clampDrawerWidth(width, windowWidth);

  // Drag the left edge to resize (the page under the pointer would take the moves, so it ignores
  // the pointer meanwhile)
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = drawerWidth;
    setResizing(true);
    const onMove = (move: PointerEvent) => setWidth(clampDrawerWidth(startWidth + startX - move.clientX, window.innerWidth));
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
  if (!state.available) body = message(t('browserDrawer.unavailableWsl'));
  else if (selected) body = <BrowserPageView pageId={selected.id} label={pageLabel(selected) || t('browserDrawer.untitled')} />;
  else if (noTabs) body = message(t('browserDrawer.noTabs'), t('browserDrawer.noTabsDescription'));
  else if (sessions.length > 0) body = loader(t('browserDrawer.loading'));
  else if (chatBrowser) body = loader(chatBrowser.status === 'starting' ? t('browserDrawer.opening') : t('browserDrawer.loading'));
  else if (chatId !== null) {
    body = message(t('browserDrawer.empty'), t('browserDrawer.emptyChatDescription'), <ChatBrowserStart projectId={projectId} chatId={chatId} />);
  } else body = message(t('browserDrawer.empty'), t('browserDrawer.emptyDescription'));

  // Closing a chat browser's last tab closes that browser
  const closeTab = (pageId: string, sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    const lastTab = pages.filter((page) => page.sessionId === sessionId).length === 1;
    if (session?.chatId && lastTab) void window.electronAPI.closeChatBrowser(projectId, session.chatId);
    else window.electronAPI.closeBrowserPage(pageId);
  };

  return (
    <div className="flex h-full shrink-0 flex-col" style={{ width: drawerWidth }}>
      {/* Window drag strip, under the Windows/Linux window controls: the drawer starts below it, level
          with the content area's top (the DEVELOPMENT BUILD strip in development builds) */}
      <div className="electron-drag shrink-0" style={{ height: TITLE_BAR_STRIP_HEIGHT }} />
      <aside className="relative flex min-h-0 flex-1 flex-col border-l border-t border-border bg-background">
        {/* Tabs */}
        <div className="flex h-10 shrink-0 items-end gap-1 border-b border-border bg-sidebar pl-2 pr-1.5">
          <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto" role="tablist" aria-label={t('browserDrawer.title')}>
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
          </div>
          <button
            type="button"
            className={cn(iconButton, 'mb-1.5')}
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
            <button type="button" className={iconButton} onClick={() => window.electronAPI.navigateBrowserPage(selected.id, 'reload')} aria-label={t('browserDrawer.reload')} title={t('browserDrawer.reload')}>
              <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            <input
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
          </form>
        )}

        {/* The page */}
        <div className={cn('relative min-h-0 flex-1', resizing && 'pointer-events-none')}>{body}</div>

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
    </div>
  );
}
