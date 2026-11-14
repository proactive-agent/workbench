import type { SidebarView } from '../components/Sidebar';

/**
 * The page each project's window showed last, kept in localStorage (flushed on quit), so a project
 * opens again on the page it was left on. The app's windows share the storage, and each writes
 * only its own project's entry, read afresh every time.
 */
const LAST_VIEWS_KEY = 'workbench.lastViews';
const VIEWS: readonly SidebarView[] = ['projects', 'kanban', 'terminals', 'insights', 'memory'];

let fallback: Record<string, SidebarView> = {};

function readLastViews(): Record<string, SidebarView> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_VIEWS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, SidebarView>) : {};
  } catch {
    return fallback;
  }
}

/** The page a project's window showed last (undefined: none remembered) */
export function lastView(projectId: string): SidebarView | undefined {
  const view = readLastViews()[projectId];
  return VIEWS.includes(view) ? view : undefined;
}

export function rememberView(projectId: string, view: SidebarView): void {
  const views = readLastViews();
  if (views[projectId] === view) return;
  fallback = { ...views, [projectId]: view };
  try {
    localStorage.setItem(LAST_VIEWS_KEY, JSON.stringify(fallback));
  } catch {
    // Remembered for this run only
  }
}
