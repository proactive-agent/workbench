import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpDown, MoreHorizontal, Search, Trash2, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '../lib/utils';
import type { Project } from '../../shared/types';

// Projects are sorted by name; the sort button toggles A–Z / Z–A
type SortMode = 'nameAsc' | 'nameDesc';

interface ProjectsPageProps {
  projects: Project[];
  activeProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onAddProject: () => void;
  onRemoveProject: (projectId: string) => void;
}

const iconButtonClass =
  'flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-nav-hover hover:text-foreground focus-visible:outline-none focus-visible:shadow-(--shadow-focus)';

/** Localized "2 days ago" style label using the active i18n language */
function useRelativeTime() {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' });
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ['year', 365 * 24 * 3600],
      ['month', 30 * 24 * 3600],
      ['week', 7 * 24 * 3600],
      ['day', 24 * 3600],
      ['hour', 3600],
      ['minute', 60]
    ];
    return (date: Date) => {
      const seconds = (new Date(date).getTime() - Date.now()) / 1000;
      for (const [unit, size] of units) {
        if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
      }
      return rtf.format(0, 'minute');
    };
  }, [i18n.language]);
}

/**
 * Projects overview (claude.ai "Projects" page): pick the active project or add a new one.
 */
export function ProjectsPage({
  projects,
  activeProjectId,
  onSelectProject,
  onAddProject,
  onRemoveProject
}: ProjectsPageProps) {
  const { t } = useTranslation('common');
  const formatRelative = useRelativeTime();
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('nameAsc');

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? projects.filter((p) => p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle))
      : projects;
    return [...filtered].sort((a, b) =>
      sortMode === 'nameAsc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
    );
  }, [projects, query, sortMode]);

  const nextSortMode: SortMode = sortMode === 'nameAsc' ? 'nameDesc' : 'nameAsc';

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-4xl px-8 pb-12 pt-14">
        {/* Header */}
        <div className="mb-10 flex items-center gap-2">
          <h1 className="flex-1 font-heading text-[2rem] font-normal! leading-tight tracking-tight text-foreground">
            {t('projectsPage.title')}
          </h1>

          {isSearching ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('');
                    setIsSearching(false);
                  }
                }}
                placeholder={t('projectsPage.searchPlaceholder')}
                aria-label={t('projectsPage.searchPlaceholder')}
                className="h-8 w-56 rounded-lg border border-border bg-transparent pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-(--input) focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
              />
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setIsSearching(false);
                }}
                className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                aria-label={t('projectsPage.closeSearch')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className={iconButtonClass} onClick={() => setIsSearching(true)} aria-label={t('projectsPage.search')}>
                  <Search className="h-[1.125rem] w-[1.125rem]" strokeWidth={1.75} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('projectsPage.search')}</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={iconButtonClass}
                onClick={() => setSortMode(nextSortMode)}
                aria-label={t(`projectsPage.sortBy.${nextSortMode}`)}
              >
                <ArrowUpDown className="h-[1.125rem] w-[1.125rem]" strokeWidth={1.75} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t(`projectsPage.sortBy.${nextSortMode}`)}</TooltipContent>
          </Tooltip>

          <button
            type="button"
            onClick={onAddProject}
            className="ml-1 h-8 rounded-lg bg-foreground px-3 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:shadow-(--shadow-focus)"
          >
            {t('projectsPage.newProject')}
          </button>
        </div>

        {/* Grid */}
        {visibleProjects.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {projects.length === 0 ? t('projectsPage.empty') : t('projectsPage.noResults')}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {visibleProjects.map((project) => {
              const isActive = project.id === activeProjectId;
              return (
                <div
                  key={project.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectProject(project.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectProject(project.id);
                    }
                  }}
                  aria-current={isActive ? 'true' : undefined}
                  className={cn(
                    // claude.ai project card: page background, hairline border; the active project gets the
                    // Kanban empty-column hover look (faint accent border and tint)
                    'group relative flex cursor-pointer flex-col rounded-xl border p-5 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
                    isActive
                      ? 'border-[rgba(var(--accent-glow-rgb),0.4)] bg-[rgba(var(--accent-glow-rgb),0.05)]'
                      : 'border-border bg-transparent hover:border-(--input)'
                  )}
                >
                  <div className="flex items-center gap-2 pr-8">
                    <span className="truncate text-[0.9375rem] font-semibold text-foreground">
                      {project.name}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 break-all text-[0.9375rem] leading-relaxed text-foreground/80">{project.path}</p>
                  {!project.autoBuildPath && (
                    <p className="mt-1 text-xs text-(--nav-label-color)">{t('projectsPage.notInitialized')}</p>
                  )}
                  <p className="mt-auto pt-5 text-sm text-muted-foreground">
                    {formatRelative(project.updatedAt)}
                  </p>

                  {/* Card actions */}
                  <div className="absolute right-2 top-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={cn(iconButtonClass, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100')}
                          aria-label={t('projectsPage.actions', { name: project.name })}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52 rounded-xl p-1.5">
                        <DropdownMenuItem
                          onSelect={() => onRemoveProject(project.id)}
                          className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-destructive focus:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                          {t('projectsPage.remove')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
