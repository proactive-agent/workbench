import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Search,
  X,
  Loader2,
  Palette,
  Bot,
  FolderOpen,
  Package,
  Bell,
  Settings2,
  Github,
  Database,
  Monitor,
  Code,
  Bug,
  Terminal,
  Users
} from 'lucide-react';

// GitLab icon component (lucide-react doesn't have one)
function GitLabIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" role="img" aria-labelledby="gitlab-icon-title">
      <title id="gitlab-icon-title">GitLab</title>
      <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z"/>
    </svg>
  );
}
import {
  FullScreenDialog,
  FullScreenDialogPortal,
  FullScreenDialogOverlay,
  FullScreenDialogTitle,
  FullScreenDialogDescription
} from '../ui/full-screen-dialog';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import { useSettings } from './hooks/useSettings';
import { ThemeSettings } from './ThemeSettings';
import { DisplaySettings } from './DisplaySettings';
import { GeneralSettings } from './GeneralSettings';
import { AdvancedSettings } from './AdvancedSettings';
import { DevToolsSettings } from './DevToolsSettings';
import { DebugSettings } from './DebugSettings';
import { TerminalFontSettings } from './terminal-font-settings/TerminalFontSettings';
import { AccountSettings } from './AccountSettings';
import { ProjectSelector } from './ProjectSelector';
import { ProjectSettingsContent, ProjectSettingsSection } from './ProjectSettingsContent';
import { useProjectStore } from '../../stores/project-store';
import type { UseProjectSettingsReturn } from '../project-settings/hooks/useProjectSettings';

interface AppSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: AppSection;
  initialProjectSection?: ProjectSettingsSection;
}

// App-level settings sections
export type AppSection = 'appearance' | 'display' | 'devtools' | 'terminal-fonts' | 'agent' | 'paths' | 'integrations' | 'accounts' | 'api-profiles' | 'updates' | 'notifications' | 'debug';

interface NavItemConfig<T extends string> {
  id: T;
  icon: React.ElementType;
}

const appNavItemsConfig: NavItemConfig<AppSection>[] = [
  { id: 'appearance', icon: Palette },
  { id: 'display', icon: Monitor },
  { id: 'devtools', icon: Code },
  { id: 'terminal-fonts', icon: Terminal },
  { id: 'agent', icon: Bot },
  { id: 'paths', icon: FolderOpen },
  { id: 'accounts', icon: Users },
  { id: 'updates', icon: Package },
  { id: 'notifications', icon: Bell },
  { id: 'debug', icon: Bug }
];

const projectNavItemsConfig: NavItemConfig<ProjectSettingsSection>[] = [
  { id: 'general', icon: Settings2 },
  { id: 'github', icon: Github },
  { id: 'gitlab', icon: GitLabIcon },
  { id: 'memory', icon: Database }
];

/**
 * Main application settings dialog container
 * Coordinates app and project settings sections
 */
export function AppSettingsDialog({ open, onOpenChange, initialSection, initialProjectSection }: AppSettingsDialogProps) {
  const { t } = useTranslation('settings');
  const { settings, setSettings, isSaving, error, saveSettings, revertTheme, commitTheme } = useSettings();
  const [version, setVersion] = useState<string>('');

  // Track which top-level section is active
  const [activeTopLevel, setActiveTopLevel] = useState<'app' | 'project'>('app');
  const [appSection, setAppSection] = useState<AppSection>(initialSection || 'appearance');
  const [projectSection, setProjectSection] = useState<ProjectSettingsSection>('general');
  const [searchQuery, setSearchQuery] = useState('');

  // Navigate to initial section when dialog opens with a specific section
  useEffect(() => {
    if (open) {
      setSearchQuery('');
      if (initialProjectSection) {
        setActiveTopLevel('project');
        setProjectSection(initialProjectSection);
      } else if (initialSection) {
        setActiveTopLevel('app');
        setAppSection(initialSection);
      }
    }
  }, [open, initialSection, initialProjectSection]);

  // Project state
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectProject = useProjectStore((state) => state.selectProject);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  // Project settings hook state (lifted from child)
  const [projectSettingsHook, setProjectSettingsHook] = useState<UseProjectSettingsReturn | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  // Load app version on mount
  useEffect(() => {
    window.electronAPI.getAppVersion().then(setVersion);
  }, []);

  // Memoize the callback to avoid infinite loops
  const handleProjectHookReady = useCallback((hook: UseProjectSettingsReturn | null) => {
    setProjectSettingsHook(hook);
    if (hook) {
      setProjectError(hook.error || hook.envError || null);
    } else {
      setProjectError(null);
    }
  }, []);

  const handleSave = async () => {
    // Save app settings first
    const appSaveSuccess = await saveSettings();

    // If on project section with a project selected, save project settings too
    if (activeTopLevel === 'project' && selectedProject && projectSettingsHook) {
      await projectSettingsHook.handleSave(() => {});
      // Check for project errors
      if (projectSettingsHook.error || projectSettingsHook.envError) {
        setProjectError(projectSettingsHook.error || projectSettingsHook.envError);
        return; // Don't close dialog on error
      }
    }

    if (appSaveSuccess) {
      // Commit the theme so future cancels won't revert to old values
      commitTheme();
      onOpenChange(false);
    }
  };

  const handleCancel = () => {
    // onOpenChange handler will revert theme changes
    onOpenChange(false);
  };

  const handleProjectChange = (projectId: string | null) => {
    selectProject(projectId);
  };

  const renderAppSection = () => {
    switch (appSection) {
      case 'appearance':
        return <ThemeSettings settings={settings} onSettingsChange={setSettings} />;
      case 'display':
        return <DisplaySettings settings={settings} onSettingsChange={setSettings} />;
      case 'devtools':
        return <DevToolsSettings settings={settings} onSettingsChange={setSettings} />;
      case 'terminal-fonts':
        return <TerminalFontSettings />;
      case 'agent':
        return <GeneralSettings settings={settings} onSettingsChange={setSettings} section="agent" />;
      case 'paths':
        return <GeneralSettings settings={settings} onSettingsChange={setSettings} section="paths" />;
      case 'accounts':
        return <AccountSettings settings={settings} onSettingsChange={setSettings} isOpen={open} />;
      case 'updates':
        return <AdvancedSettings settings={settings} onSettingsChange={setSettings} section="updates" version={version} />;
      case 'notifications':
        return <AdvancedSettings settings={settings} onSettingsChange={setSettings} section="notifications" version={version} />;
      case 'debug':
        return <DebugSettings />;
      default:
        return null;
    }
  };

  const renderContent = () => {
    if (activeTopLevel === 'app') {
      return renderAppSection();
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

  // Determine if project nav items should be disabled
  const projectNavDisabled = !selectedProjectId;
  const isSavingAny = isSaving || (activeTopLevel === 'project' && !!projectSettingsHook?.isSaving);

  // Filter nav items by translated title (case-insensitive)
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchesQuery = (title: string) => !normalizedQuery || title.toLowerCase().includes(normalizedQuery);
  const filteredAppItems = appNavItemsConfig.filter((item) => matchesQuery(t(`sections.${item.id}.title`)));
  const filteredProjectItems = projectNavItemsConfig.filter((item) => matchesQuery(t(`projectSections.${item.id}.title`)));
  const hasNoResults = filteredAppItems.length === 0 && filteredProjectItems.length === 0;

  const rowClass = (isActive: boolean) => cn(
    'group flex h-8 w-full items-center gap-(--nav-item-gap) rounded-(--nav-item-radius) px-0.5 text-left text-sm text-muted-foreground',
    'transition-colors duration-150 ease-out',
    'hover:bg-nav-hover hover:text-nav-hover-foreground',
    'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
    'disabled:pointer-events-none disabled:opacity-50',
    isActive && 'bg-nav-active text-nav-active-foreground hover:bg-nav-active hover:text-nav-active-foreground'
  );

  const renderRowIcon = (Icon: React.ElementType) => (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center">
      <Icon className="h-4 w-4" strokeWidth={1.75} />
    </span>
  );

  const isWideSection = activeTopLevel === 'app' && appSection === 'terminal-fonts';

  return (
    <FullScreenDialog open={open} onOpenChange={(newOpen) => {
      if (!newOpen) {
        // Dialog is being closed (via X, escape, or overlay click)
        // Revert any unsaved theme changes
        revertTheme();
      }
      onOpenChange(newOpen);
    }}>
      <FullScreenDialogPortal>
        <FullScreenDialogOverlay className="bg-black/40 backdrop-blur-none" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2',
            'h-[min(820px,calc(100vh-2rem))] w-[min(1120px,calc(100vw-2rem))]',
            'overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-98 data-[state=open]:zoom-in-98',
            'duration-200 focus:outline-none'
          )}
        >
          <FullScreenDialogTitle className="sr-only">{t('title')}</FullScreenDialogTitle>
          <FullScreenDialogDescription className="sr-only">
            {t('tabs.app')} & {t('tabs.project')}
          </FullScreenDialogDescription>

          {/* Navigation sidebar */}
          <nav
            aria-label={t('title')}
            className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar"
          >
            <div className="p-3 pb-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('search.placeholder')}
                  aria-label={t('search.ariaLabel')}
                  className={cn(
                    'h-8 w-full rounded-lg border border-border bg-transparent pl-8 pr-2 text-sm text-foreground',
                    'placeholder:text-muted-foreground',
                    'transition-colors focus-visible:outline-none focus-visible:border-(--input)',
                    '[&::-webkit-search-cancel-button]:appearance-none'
                  )}
                />
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 px-3 pb-3">
                {/* Application group */}
                {filteredAppItems.length > 0 && (
                  <div>
                    <h3 className="nav-section-label flex h-8 items-center px-2 text-[0.8125rem]">
                      {t('nav.app')}
                    </h3>
                    <div className="space-y-px">
                      {filteredAppItems.map((item) => {
                        const isActive = activeTopLevel === 'app' && appSection === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-current={isActive ? 'page' : undefined}
                            onClick={() => {
                              setActiveTopLevel('app');
                              setAppSection(item.id);
                            }}
                            className={rowClass(isActive)}
                          >
                            {renderRowIcon(item.icon)}
                            <span className="truncate">{t(`sections.${item.id}.title`)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Project group */}
                {filteredProjectItems.length > 0 && (
                  <div>
                    <h3 className="nav-section-label flex h-8 items-center px-2 text-[0.8125rem]">
                      {t('nav.project')}
                    </h3>

                    <div className="mb-1 px-0.5">
                      <ProjectSelector
                        selectedProjectId={selectedProjectId}
                        onProjectChange={handleProjectChange}
                        compact
                      />
                    </div>

                    <div className="space-y-px">
                      {filteredProjectItems.map((item) => {
                        const isActive = activeTopLevel === 'project' && projectSection === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-current={isActive ? 'page' : undefined}
                            onClick={() => {
                              setActiveTopLevel('project');
                              setProjectSection(item.id);
                            }}
                            disabled={projectNavDisabled}
                            className={rowClass(isActive)}
                          >
                            {renderRowIcon(item.icon)}
                            <span className="truncate">{t(`projectSections.${item.id}.title`)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {hasNoResults && (
                  <p className="px-2 py-2 text-[0.8125rem] text-muted-foreground">{t('search.noResults')}</p>
                )}
              </div>
            </ScrollArea>

            {/* Version at bottom */}
            {version && (
              <div className="px-5 py-3">
                <p className="text-xs text-muted-foreground">
                  {t('updates.version')} {version}
                </p>
              </div>
            )}
          </nav>

          {/* Main content */}
          <div className="relative flex min-w-0 flex-1 flex-col">
            <DialogPrimitive.Close
              aria-label={t('actions.close')}
              className={cn(
                'absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg',
                'text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground',
                'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)'
              )}
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </DialogPrimitive.Close>

            <ScrollArea className="min-h-0 flex-1">
              <div
                className={cn(
                  'mx-auto w-full px-10 pb-10 pt-12',
                  isWideSection ? 'max-w-5xl' : 'max-w-[720px]'
                )}
              >
                {renderContent()}
              </div>
            </ScrollArea>

            {/* Sticky footer */}
            <div className="shrink-0 border-t border-border px-10 py-3">
              <div
                className={cn(
                  'mx-auto flex w-full items-center justify-end gap-2',
                  isWideSection ? 'max-w-5xl' : 'max-w-[720px]'
                )}
              >
                {(error || projectError) && (
                  <div
                    role="alert"
                    className="mr-auto min-w-0 flex-1 truncate rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
                    title={error || projectError || undefined}
                  >
                    {error || projectError}
                  </div>
                )}
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  {t('common:buttons.cancel', 'Cancel')}
                </Button>
                <Button size="sm" onClick={handleSave} disabled={isSavingAny}>
                  {isSavingAny ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {t('common:buttons.saving', 'Saving...')}
                    </>
                  ) : (
                    t('common:buttons.save', 'Save')
                  )}
                </Button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </FullScreenDialogPortal>
    </FullScreenDialog>
  );
}
