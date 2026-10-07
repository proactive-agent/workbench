/**
 * @vitest-environment jsdom
 */
/**
 * Tests for the project navigation that replaced the project tab bar:
 * project switching shortcuts and the ProjectsPage overview.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, renderHook, screen, fireEvent } from '@testing-library/react';
import type { Project } from '../../../shared/types';
import { TooltipProvider } from '../ui/tooltip';
import { useProjectShortcuts } from '../../hooks/useProjectShortcuts';
import { ProjectsPage } from '../ProjectsPage';

// Return keys (with interpolated values) so assertions don't depend on English copy
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
    i18n: { language: 'en' }
  })
}));

function project(id: string, name: string, updatedAt: string): Project {
  return {
    id,
    name,
    path: `/work/${name.toLowerCase()}`,
    autoBuildPath: `/work/${name.toLowerCase()}/.auto-claude`,
    settings: {
      model: 'sonnet',
      memoryBackend: 'file',
      linearSync: false,
      notifications: { onTaskComplete: true, onTaskFailed: true, onReviewNeeded: true, sound: false }
    },
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt)
  };
}

const projects = [
  project('a', 'Alpha', '2026-10-01T00:00:00Z'),
  project('b', 'Bravo', '2026-10-05T00:00:00Z'),
  project('c', 'Charlie', '2026-10-03T00:00:00Z')
];

describe('useProjectShortcuts', () => {
  const onSelectProject = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  const mount = (activeProjectId: string | null) =>
    renderHook(() => useProjectShortcuts(projects, activeProjectId, onSelectProject));

  it('jumps to the Nth project with Ctrl+N', () => {
    mount('a');
    fireEvent.keyDown(window, { key: '3', ctrlKey: true });
    expect(onSelectProject).toHaveBeenCalledWith('c');
  });

  it('ignores Ctrl+N beyond the number of projects', () => {
    mount('a');
    fireEvent.keyDown(window, { key: '7', ctrlKey: true });
    expect(onSelectProject).not.toHaveBeenCalled();
  });

  it('cycles forward and backward with Ctrl+Tab / Ctrl+Shift+Tab', () => {
    mount('c');
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(onSelectProject).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(onSelectProject).toHaveBeenLastCalledWith('b');
  });

  it('does not switch projects while typing in an input', () => {
    mount('a');
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '2', ctrlKey: true });
    expect(onSelectProject).not.toHaveBeenCalled();
    input.remove();
  });

  it('ignores the digits without a modifier', () => {
    mount('a');
    fireEvent.keyDown(window, { key: '2' });
    expect(onSelectProject).not.toHaveBeenCalled();
  });
});

describe('ProjectsPage', () => {
  const handlers = { onSelectProject: vi.fn(), onAddProject: vi.fn(), onRemoveProject: vi.fn() };

  beforeEach(() => vi.clearAllMocks());

  function renderPage(list: Project[] = projects) {
    return render(
      <TooltipProvider>
        <ProjectsPage projects={list} activeProjectId="b" {...handlers} />
      </TooltipProvider>
    );
  }

  const cardNames = () =>
    screen.getAllByRole('button').filter((el) => el.hasAttribute('tabindex')).map((el) => el.querySelector('span')?.textContent);

  it('lists projects by most recently updated first', () => {
    renderPage();
    expect(cardNames()).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('toggles to alphabetical order', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'projectsPage.sortBy.name' }));
    expect(cardNames()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('filters by name or path when searching', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'projectsPage.search' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'char' } });
    expect(cardNames()).toEqual(['Charlie']);
  });

  it('selects a project when its card is clicked', () => {
    renderPage();
    fireEvent.click(screen.getByText('Alpha'));
    expect(handlers.onSelectProject).toHaveBeenCalledWith('a');
  });

  it('marks the active project', () => {
    renderPage();
    expect(screen.getByText('projectsPage.active')).toBeInTheDocument();
  });

  it('opens the add-project flow from "New project"', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'projectsPage.newProject' }));
    expect(handlers.onAddProject).toHaveBeenCalled();
  });

  it('shows an empty state without projects', () => {
    renderPage([]);
    expect(screen.getByText('projectsPage.empty')).toBeInTheDocument();
  });
});
