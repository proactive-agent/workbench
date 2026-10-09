import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  X,
  CircleUserRound,
  CodeXml,
  Download,
  Blocks
} from 'lucide-react';
import { AgentOutlineIcon, GearIcon, MemoryChipIcon, ProjectOutlineIcon } from '../icons/app-icons';

import {
  FullScreenDialog,
  FullScreenDialogPortal,
  FullScreenDialogOverlay,
  FullScreenDialogTitle,
  FullScreenDialogDescription
} from '../ui/full-screen-dialog';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import { useSettings } from './hooks/useSettings';
import { ThemeSettings } from './ThemeSettings';
import { GeneralSettings } from './GeneralSettings';
import { AdvancedSettings } from './AdvancedSettings';
import { ClaudeCodeSettings } from './ClaudeCodeSettings';
import { DevToolsSettings } from './DevToolsSettings';
import { DebugSettings } from './DebugSettings';
import { AccountSettings } from './AccountSettings';
import { ProjectSettingsContent, ProjectSettingsSection } from './ProjectSettingsContent';
import { ConnectorsSettings } from './ConnectorsSettings';
import { useProjectStore } from '../../stores/project-store';
import type { UseProjectSettingsReturn } from '../project-settings/hooks/useProjectSettings';
import {
  DIALOG_ANIMATION_CLASS,
  DIALOG_CLOSE_BUTTON_CLASS,
  DIALOG_CLOSE_ICON_CLASS,
  DIALOG_CLOSE_ICON_STROKE,
  DIALOG_SURFACE_CLASS
} from '../ui/dialog-styles';

interface AppSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: AppSection;
  initialProjectSection?: ProjectSettingsSection;
}

// App-level settings pages (claude.ai layout: related settings grouped on one page)
type AppPage = 'general' | 'accounts' | 'agent' | 'connectors' | 'devtools' | 'updates';

// Section ids accepted from the rest of the app; older ids map onto the page that now holds them
export type AppSection = AppPage | 'terminal-fonts' | 'appearance' | 'display' | 'notifications' | 'paths' | 'debug' | 'integrations' | 'api-profiles';

const LEGACY_SECTION_PAGE: Record<string, AppPage> = {
  'terminal-fonts': 'agent',
  appearance: 'general',
  display: 'general',
  notifications: 'general',
  paths: 'devtools',
  debug: 'devtools',
  integrations: 'accounts',
  'api-profiles': 'accounts'
};

const toAppPage = (section: AppSection): AppPage => LEGACY_SECTION_PAGE[section] ?? (section as AppPage);

interface NavItemConfig<T extends string> {
  id: T;
  icon: React.ElementType;
  /** Size override for icons whose artwork reads small at the default 18px */
  iconClassName?: string;
  /** Stroke width to keep lines as thin as the 18px icons' when the icon is larger */
  iconStrokeWidth?: number;
}

// One list: app pages, then the selected project's pages (Project, Memory) above Updates
type TopNavItem =
  | ({ kind: 'app' } & NavItemConfig<AppPage>)
  | ({ kind: 'project' } & NavItemConfig<ProjectSettingsSection>);

const topNavItemsConfig: TopNavItem[] = [
  { kind: 'app', id: 'general', icon: GearIcon },
  { kind: 'app', id: 'accounts', icon: CircleUserRound },
  // The wide, short creature reads small at 18px: 20px, with the extra 2px taken out of the gap
  { kind: 'app', id: 'agent', icon: AgentOutlineIcon, iconClassName: '-mx-px h-5 w-5', iconStrokeWidth: 1.35 },
  { kind: 'app', id: 'connectors', icon: Blocks },
  { kind: 'app', id: 'devtools', icon: CodeXml },
  { kind: 'project', id: 'general', icon: ProjectOutlineIcon },
  { kind: 'project', id: 'memory', icon: MemoryChipIcon },
  { kind: 'app', id: 'updates', icon: Download }
];

// Changes save on their own (claude.ai has no Save button); quick edits are batched
const AUTOSAVE_DELAY_MS = 400;

/**
 * Settings dialog modeled on claude.ai's: a narrow navigation column (search, grouped pages)
 * next to a scrolling page of sections. Changes apply and save immediately.
 */
export function AppSettingsDialog({ open, onOpenChange, initialSection, initialProjectSection }: AppSettingsDialogProps) {
  const { t } = useTranslation('settings');
  const { settings, setSettings, error, saveSettings, commitTheme } = useSettings();
  const [version, setVersion] = useState<string>('');

  // Track which top-level group is active
  const [activeTopLevel, setActiveTopLevel] = useState<'app' | 'project'>('app');
  const [appPage, setAppPage] = useState<AppPage>(initialSection ? toAppPage(initialSection) : 'general');
  const [projectSection, setProjectSection] = useState<ProjectSettingsSection>('general');

  // Navigate to the requested page when the dialog opens
  useEffect(() => {
    if (open) {
      if (initialProjectSection) {
        setActiveTopLevel('project');
        setProjectSection(initialProjectSection);
      } else if (initialSection) {
        setActiveTopLevel('app');
        setAppPage(toAppPage(initialSection));
      } else {
        // Opened without a target (e.g. from the sidebar): start on the first page
        setActiveTopLevel('app');
        setAppPage('general');
      }
    }
  }, [open, initialSection, initialProjectSection]);

  // Project state
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const [projectError, setProjectError] = useState<string | null>(null);

  // Load app version on mount
  useEffect(() => {
    window.electronAPI.getAppVersion().then(setVersion);
  }, []);

  const handleProjectHookReady = useCallback((hook: UseProjectSettingsReturn | null) => {
    setProjectError(hook ? hook.error || hook.envError || null : null);
  }, []);

  // --- Autosave app settings -------------------------------------------------
  // lastSaved holds the persisted snapshot; edits made while the dialog is open are saved after a
  // short pause, and any pending save is flushed when the dialog closes.
  const lastSavedRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(saveSettings);
  saveRef.current = saveSettings;
  const serialized = JSON.stringify(settings);

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (lastSavedRef.current !== null && lastSavedRef.current !== serialized) {
      const saved = await saveRef.current();
      if (saved) {
        lastSavedRef.current = serialized;
        commitTheme();
      }
    }
  }, [serialized, commitTheme]);

  useEffect(() => {
    if (!open) {
      lastSavedRef.current = null;
      return;
    }
    // First render after opening: take the current settings as the saved baseline
    if (lastSavedRef.current === null) {
      lastSavedRef.current = serialized;
      return;
    }
    if (lastSavedRef.current === serialized) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, AUTOSAVE_DELAY_MS);
  }, [open, serialized, flushSave]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      void flushSave();
    }
    onOpenChange(newOpen);
  };

  const renderAppPage = () => {
    switch (appPage) {
      case 'general':
        return (
          <>
            <ThemeSettings settings={settings} onSettingsChange={setSettings} />
            <AdvancedSettings settings={settings} onSettingsChange={setSettings} section="notifications" version={version} />
          </>
        );
      case 'accounts':
        return <AccountSettings settings={settings} onSettingsChange={setSettings} isOpen={open} />;
      case 'agent':
        return <GeneralSettings settings={settings} onSettingsChange={setSettings} section="agent" />;
      case 'connectors':
        return <ConnectorsSettings settings={settings} onSettingsChange={setSettings} />;
      case 'devtools':
        return (
          <>
            <DevToolsSettings settings={settings} onSettingsChange={setSettings} />
            <GeneralSettings settings={settings} onSettingsChange={setSettings} section="paths" />
            <DebugSettings />
          </>
        );
      case 'updates':
        return (
          <>
            <AdvancedSettings settings={settings} onSettingsChange={setSettings} section="updates" version={version} />
            {/* Claude Code CLI (status, install/update, version and installation switching) */}
            <ClaudeCodeSettings />
          </>
        );
      default:
        return null;
    }
  };

  const renderContent = () => {
    if (activeTopLevel === 'app') {
      return renderAppPage();
    }
    return (
      <ProjectSettingsContent
        project={selectedProject}
        activeSection={projectSection}
        isOpen={open}
        onHookReady={handleProjectHookReady}
      />
    );
  };

  const projectNavDisabled = !selectedProjectId;


  const navItemClass = (isActive: boolean) => cn(
    'flex h-8 w-full items-center gap-3 rounded-lg px-2 text-left text-sm outline-none',
    'focus-visible:shadow-(--shadow-focus) disabled:pointer-events-none disabled:opacity-50',
    isActive
      ? 'bg-nav-active font-medium text-foreground'
      : 'text-muted-foreground hover:bg-nav-hover hover:text-foreground'
  );

  const renderNavIcon = (Icon: React.ElementType, sizeClassName = 'h-[1.125rem] w-[1.125rem]', strokeWidth = 1.5) => (
    <Icon className={cn(sizeClassName, 'shrink-0 text-muted-foreground')} strokeWidth={strokeWidth} />
  );


  return (
    <FullScreenDialog open={open} onOpenChange={handleOpenChange}>
      <FullScreenDialogPortal>
        <FullScreenDialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2',
            'h-[min(800px,calc(100vh-2rem))] w-[min(1024px,calc(100vw-2rem))] overflow-hidden',
            DIALOG_SURFACE_CLASS,
            'bg-settings-surface',
            DIALOG_ANIMATION_CLASS
          )}
          // Like claude.ai, open without focusing (and ringing) the search field
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <FullScreenDialogTitle className="sr-only">{t('title')}</FullScreenDialogTitle>
          <FullScreenDialogDescription className="sr-only">
            {t('tabs.app')} & {t('tabs.project')}
          </FullScreenDialogDescription>

          {/* Navigation column */}
          <nav aria-label={t('title')} className="flex w-48 shrink-0 flex-col border-r border-border bg-settings-nav pt-3">
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-3 px-3 pb-3">
                <div>
                  <div className="px-2 pb-2 pt-3 text-xs text-(--nav-label-color)">{t('nav.app')}</div>
                  <ul className="flex flex-col gap-px">
                    {topNavItemsConfig.map((item) => {
                      const isProject = item.kind === 'project';
                      const isActive = isProject
                        ? activeTopLevel === 'project' && projectSection === item.id
                        : activeTopLevel === 'app' && appPage === item.id;
                      return (
                        <li key={`${item.kind}-${item.id}`}>
                          <button
                            type="button"
                            aria-current={isActive ? 'page' : undefined}
                            onClick={() => {
                              if (item.kind === 'project') {
                                setActiveTopLevel('project');
                                setProjectSection(item.id);
                              } else {
                                setActiveTopLevel('app');
                                setAppPage(item.id);
                              }
                            }}
                            disabled={isProject && projectNavDisabled}
                            className={navItemClass(isActive)}
                          >
                            {renderNavIcon(item.icon, item.iconClassName, item.iconStrokeWidth)}
                            <span className="min-w-0 flex-1 truncate">
                              {isProject
                                ? item.id === 'general' ? t('nav.project') : t(`projectSections.${item.id}.title`)
                                : t(`sections.${item.id}.title`)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

              </div>
            </ScrollArea>
          </nav>

          {/* Page */}
          <div className="relative flex min-w-0 flex-1 flex-col">
            {/* Top bar holding the close button: page content scrolls under it, not under the X */}
            <div className="h-14 shrink-0 bg-settings-surface">
              <DialogPrimitive.Close aria-label={t('actions.close')} className={DIALOG_CLOSE_BUTTON_CLASS}>
                <X className={DIALOG_CLOSE_ICON_CLASS} strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
              </DialogPrimitive.Close>
            </div>

            {(error || projectError) && (
              <div
                role="alert"
                className="mx-7 mb-4 truncate rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                title={error || projectError || undefined}
              >
                {error || projectError}
              </div>
            )}

            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto w-full max-w-[832px] px-7 pb-10">
                {renderContent()}
              </div>
            </ScrollArea>
          </div>
        </DialogPrimitive.Content>
      </FullScreenDialogPortal>
    </FullScreenDialog>
  );
}
