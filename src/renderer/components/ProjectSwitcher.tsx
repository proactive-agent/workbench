import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown, Folder, LayoutGrid, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import type { Project } from '../../shared/types';

interface ProjectSwitcherProps {
  projects: Project[];
  activeProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onShowAllProjects: () => void;
  onAddProject: () => void;
  isCollapsed: boolean;
  /** Row styling shared with the other sidebar rows */
  rowClassName: string;
}

// Same modifier hint the project tabs used (renderer can't reach the platform module)
const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const modKey = isMac ? '⌘' : 'Ctrl+';

const itemClass = 'cursor-pointer rounded-lg px-2 py-1.5 text-sm focus:bg-nav-hover data-[highlighted]:bg-nav-hover';

/**
 * Sidebar dropdown showing the active project and listing every project to switch to.
 * Also owns the project-switching shortcuts that used to live on the project tab bar:
 * Cmd/Ctrl+1-9 jumps to the Nth project, Cmd/Ctrl+Tab (+Shift) cycles through them.
 */
export function ProjectSwitcher({
  projects,
  activeProjectId,
  onSelectProject,
  onShowAllProjects,
  onAddProject,
  isCollapsed,
  rowClassName
}: ProjectSwitcherProps) {
  const { t } = useTranslation('navigation');
  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip regular inputs, but not xterm's hidden textarea (it forwards these shortcuts)
      const target = e.target as HTMLElement;
      const isXtermTextarea = target.classList?.contains('xterm-helper-textarea');
      if (
        !isXtermTextarea &&
        (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable)
      ) {
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || projects.length === 0) return;

      if (e.key >= '1' && e.key <= '9') {
        const project = projects[parseInt(e.key, 10) - 1];
        if (project) {
          e.preventDefault();
          onSelectProject(project.id);
        }
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        const current = projects.findIndex((p) => p.id === activeProjectId);
        const next = current === -1
          ? 0
          : (current + (e.shiftKey ? -1 : 1) + projects.length) % projects.length;
        onSelectProject(projects[next].id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projects, activeProjectId, onSelectProject]);

  const label = activeProject?.name ?? t('projectSwitcher.noProject');

  const trigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className={cn(rowClassName, 'data-[state=open]:bg-nav-hover')}
        aria-label={t('projectSwitcher.ariaLabel', { name: label })}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">
          <Folder className="h-4 w-4" strokeWidth={1.75} />
        </span>
        {!isCollapsed && (
          <>
            <span className={cn('min-w-0 flex-1 truncate text-left', activeProject && 'text-foreground')}>{label}</span>
            <ChevronsUpDown className="mr-1.5 h-3.5 w-3.5 shrink-0 text-(--nav-label-color)" />
          </>
        )}
      </button>
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {isCollapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent
        side={isCollapsed ? 'right' : 'bottom'}
        align="start"
        sideOffset={4}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-xl p-1.5"
      >
        <DropdownMenuLabel className="px-2 py-1 text-[0.8125rem] font-normal text-(--nav-label-color)">
          {t('projectSwitcher.label')}
        </DropdownMenuLabel>
        <div className="max-h-80 overflow-y-auto">
          {projects.map((project, index) => (
            <DropdownMenuItem
              key={project.id}
              onSelect={() => onSelectProject(project.id)}
              className={cn(itemClass, 'flex items-center gap-2')}
            >
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {index < 9 && (
                <span className="shrink-0 text-xs text-(--nav-label-color)">
                  {t('projectSwitcher.shortcut', { mod: modKey, index: index + 1 })}
                </span>
              )}
              {project.id === activeProjectId ? (
                <Check className="h-4 w-4 shrink-0 text-ring" strokeWidth={2.25} />
              ) : (
                <span className="w-4 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator className="mx-2 my-1.5" />
        <DropdownMenuItem onSelect={onShowAllProjects} className={cn(itemClass, 'flex items-center gap-2')}>
          <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          {t('projectSwitcher.allProjects')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAddProject} className={cn(itemClass, 'flex items-center gap-2')}>
          <Plus className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          {t('projectSwitcher.addProject')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
