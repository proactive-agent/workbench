import { useEffect } from 'react';
import type { Project } from '../../shared/types';

/**
 * Project switching shortcuts: Cmd/Ctrl+1-9 jumps to the Nth project, Cmd/Ctrl+Tab (+Shift)
 * cycles through them. Ignored while typing in inputs, except xterm's hidden textarea (the
 * terminal forwards these shortcuts).
 */
export function useProjectShortcuts(
  projects: Project[],
  activeProjectId: string | null,
  onSelectProject: (projectId: string) => void
): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
}
