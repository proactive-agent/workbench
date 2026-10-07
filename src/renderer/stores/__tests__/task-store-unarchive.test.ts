/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for unarchiving tasks from the task store
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUnarchiveTasks = vi.fn();
const mockGetTasks = vi.fn();

vi.stubGlobal('window', {
  electronAPI: {
    unarchiveTasks: mockUnarchiveTasks,
    getTasks: mockGetTasks
  }
});

describe('unarchiveTasks', () => {
  let unarchiveTasks: typeof import('../task-store').unarchiveTasks;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetTasks.mockResolvedValue({ success: true, data: [] });
    ({ unarchiveTasks } = await import('../task-store'));
  });

  it('unarchives the tasks and reloads the board', async () => {
    mockUnarchiveTasks.mockResolvedValue({ success: true, data: true });

    const result = await unarchiveTasks('project-1', ['task-1']);

    expect(result).toEqual({ success: true });
    expect(mockUnarchiveTasks).toHaveBeenCalledWith('project-1', ['task-1']);
    expect(mockGetTasks).toHaveBeenCalled();
  });

  it('reports the IPC error without reloading', async () => {
    mockUnarchiveTasks.mockResolvedValue({ success: false, error: 'Spec directory not found' });

    const result = await unarchiveTasks('project-1', ['task-1']);

    expect(result).toEqual({ success: false, error: 'Spec directory not found' });
    expect(mockGetTasks).not.toHaveBeenCalled();
  });

  it('turns a thrown error into a failure result', async () => {
    mockUnarchiveTasks.mockRejectedValue(new Error('IPC unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await unarchiveTasks('project-1', ['task-1']);

    expect(result).toEqual({ success: false, error: 'IPC unavailable' });
  });
});
