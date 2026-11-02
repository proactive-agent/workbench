import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task, TaskStatus } from '../../../shared/types';
import type { TaskChangelogEntry } from '../../task-changelog';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { configureTaskMessaging, resetTaskMessagingForTests, takeInbox } from '../broker';
import { TaskNotices } from '../notices';
import type { FindConflicts } from '../conflict-check';

let root: string;
let project: Project;
let tasks: Task[];
let notices: TaskNotices;

function task(specId: string, status: TaskStatus, metadata: Task['metadata'] = {}): Task {
  return { id: specId, specId, projectId: 'p1', title: `T${specId.slice(0, 3)}`, description: '', status, subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date() };
}

function changelog(entries: TaskChangelogEntry[]): void {
  mkdirSync(path.join(root, '.workbench'), { recursive: true });
  writeFileSync(path.join(root, '.workbench', 'changelog.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'));
}

const texts = async (specId: string) => (await takeInbox('p1', specId)).map((m) => m.text);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'notices-'));
  project = { id: 'p1', name: 'P', path: root, autoBuildPath: '.workbench', settings: { mainBranch: 'main' } } as unknown as Project;
  tasks = [task('001-a', 'in_progress'), task('002-b', 'in_progress'), task('003-c', 'queue'), task('004-d', 'done')];
  configureTaskMessaging({ getProject: () => project, getTasks: () => tasks });
  notices = new TaskNotices({ batchMs: 60_000, editBatchMs: 60_000, isMerged: async () => true });
});

afterEach(() => {
  notices.stop();
  resetTaskMessagingForTests();
  rmSync(root, { recursive: true, force: true });
});

describe('TaskNotices', () => {
  it('tells the other active and queued tasks that a task started, once per start', async () => {
    await notices.onState({ project, task: tasks[0], status: 'queue' });
    await notices.onState({ project, task: tasks[0], status: 'in_progress', state: 'planning' });
    await notices.onState({ project, task: tasks[0], status: 'in_progress', state: 'coding' });
    await notices.flush();

    expect(await texts('002-b')).toEqual([expect.stringMatching(/^Task 001-a "T001" \(session wb-[a-z0-9]{6}-001-a\) started\.$/)]);
    expect(await texts('003-c')).toHaveLength(1);
    expect(await texts('001-a')).toEqual([]);
    expect(await texts('004-d')).toEqual([]);
  });

  it('test-merges tasks that share a file and tells both about a conflict with its lines, once while it lasts', async () => {
    const findConflicts = vi.fn<FindConflicts>(async () => [{ file: 'src/shared.ts', lines: 'lines 4-6', otherLines: 'line 5' }]);
    notices = new TaskNotices({ batchMs: 60_000, editBatchMs: 60_000, findConflicts });
    changelog([{ at: '2026-10-01T00:00:00Z', task: '002-b', event: 'state', status: 'in_progress', files: ['src/shared.ts', 'src/b.ts'] }]);
    notices.onFilesEdited({ project, task: tasks[0], files: ['src/shared.ts', 'src/a.ts'] });
    notices.onFilesEdited({ project, task: tasks[0], files: ['src/shared.ts'] });
    await notices.flush();
    notices.onFilesEdited({ project, task: tasks[0], files: ['src/shared.ts'] });
    await notices.flush();

    expect(findConflicts).toHaveBeenCalledTimes(2);
    expect(findConflicts).toHaveBeenCalledWith(project, '001-a', '002-b');
    const mine = await texts('001-a');
    expect(mine).toEqual([expect.stringMatching(/^Your changes conflict with Task 002-b .* in `src\/shared\.ts` \(lines 4-6\): you both change the same lines\. Agree with it via message_task/)]);
    const theirs = await texts('002-b');
    expect(theirs).toEqual([expect.stringMatching(/^Your changes conflict with Task 001-a .* in `src\/shared\.ts` \(line 5\)/)]);

    // Resolved, then conflicting again: announced again (the inbox keeps the first one)
    findConflicts.mockResolvedValueOnce([]);
    notices.onFilesEdited({ project, task: tasks[0], files: ['src/shared.ts'] });
    await notices.flush();
    notices.onFilesEdited({ project, task: tasks[0], files: ['src/shared.ts'] });
    await notices.flush();
    expect(await texts('001-a')).toHaveLength(2);
  });

  it('says nothing when the shared files merge cleanly, and never checks tasks that share none', async () => {
    const findConflicts = vi.fn<FindConflicts>(async () => []);
    notices = new TaskNotices({ batchMs: 60_000, editBatchMs: 60_000, findConflicts });
    changelog([{ at: '2026-10-01T00:00:00Z', task: '002-b', event: 'state', status: 'in_progress', files: ['src/shared.ts'] }]);
    notices.onFilesEdited({ project, task: tasks[0], files: ['src/shared.ts'] });
    notices.onFilesEdited({ project, task: tasks[2], files: ['src/c.ts'] });
    await notices.flush();
    expect(findConflicts).toHaveBeenCalledTimes(1);
    expect(await texts('001-a')).toEqual([]);
    expect(await texts('002-b')).toEqual([]);
  });

  it("falls back to the shared files when the test merge can't run, once per pair and file", async () => {
    notices = new TaskNotices({ batchMs: 60_000, editBatchMs: 60_000, findConflicts: async () => null });
    changelog([{ at: '2026-10-01T00:00:00Z', task: '002-b', event: 'state', status: 'in_progress', files: ['src/shared.ts', 'src/b.ts'] }]);
    notices.onFilesEdited({ project, task: tasks[0], files: ['src/shared.ts', 'src/a.ts'] });
    await notices.flush();
    notices.onFilesEdited({ project, task: tasks[0], files: ['src/shared.ts'] });
    await notices.flush();

    const mine = await texts('001-a');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('Task 002-b');
    expect(mine[0]).toContain('`src/shared.ts`');
    expect(mine[0]).toContain('merge cleanly');
    expect(mine[0]).not.toContain('src/a.ts');
    const theirs = await texts('002-b');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toContain('Task 001-a');
  });

  it('batches several notices for one target into one message', async () => {
    await notices.onState({ project, task: tasks[0], status: 'in_progress', state: 'planning' });
    await notices.onState({ project, task: tasks[2], status: 'queue' });
    tasks[2].status = 'in_progress';
    await notices.onState({ project, task: tasks[2], status: 'in_progress', state: 'planning' });
    await notices.flush();
    const [batch] = await texts('002-b');
    expect(batch).toMatch(/^Updates on parallel tasks:\n- Task 001-a .* started\.\n- Task 003-c .* started\.$/);
  });

  it('tells overlapping active tasks when a task finished, with its summary', async () => {
    changelog([
      { at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
      { at: '2026-10-01T00:00:01Z', task: '002-b', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
      { at: '2026-10-01T00:00:02Z', task: '003-c', event: 'state', status: 'queue', files: ['src/other.ts'] },
    ]);
    const specDir = path.join(root, '.workbench', 'tasks', '001-a');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify({ summary: 'Added X', phases: [{ name: 'implement' }] }));
    await notices.onState({ project, task: tasks[0], status: 'in_progress', state: 'coding' });
    await notices.onState({ project, task: tasks[0], status: 'human_review', state: 'human_review' });
    await notices.flush();
    const [notice] = await texts('002-b');
    expect(notice).toContain('finished and waits for review (not merged yet)');
    expect(notice).toContain('Its summary: Added X');
    expect(notice).not.toContain('Decisions');
    expect((await texts('003-c')).some((t) => t.includes('finished'))).toBe(false);
  });

  it("adds the finished task's decisions and API changes line, taken from its validation summary", async () => {
    changelog([
      { at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
      { at: '2026-10-01T00:00:01Z', task: '002-b', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
    ]);
    const specDir = path.join(root, '.workbench', 'tasks', '001-a');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify({
      summary: 'Implemented X',
      validation: { summary: 'Renamed the loader.\nChecks pass.\n\n**Decisions/API changes:** `loadUser(id)` now returns `User | null`; dates are ISO strings', checks: [], findings: [] },
      phases: [{ name: 'validate' }],
    }));
    await notices.onState({ project, task: tasks[0], status: 'in_progress', state: 'coding' });
    await notices.onState({ project, task: tasks[0], status: 'human_review', state: 'human_review' });
    await notices.flush();
    const [notice] = await texts('002-b');
    expect(notice.split('\n')).toEqual([
      expect.stringMatching(/finished and waits for review .* Its summary: Renamed the loader\. Checks pass\.$/),
      'Decisions and API changes: `loadUser(id)` now returns `User | null`; dates are ISO strings',
    ]);
  });

  it('leaves the decisions line out when the task says there are none', async () => {
    changelog([
      { at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
      { at: '2026-10-01T00:00:01Z', task: '002-b', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
    ]);
    const specDir = path.join(root, '.workbench', 'tasks', '001-a');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify({ summary: 'Fixed a typo.\nDecisions/API changes: none', phases: [{ name: 'implement' }] }));
    await notices.onState({ project, task: tasks[0], status: 'in_progress', state: 'coding' });
    await notices.onState({ project, task: tasks[0], status: 'human_review', state: 'human_review' });
    await notices.flush();
    const [notice] = await texts('002-b');
    expect(notice).toMatch(/Its summary: Fixed a typo\.$/);
  });

  it('says nothing about a stopped run, and tells running tasks on the same base to merge it after a merge', async () => {
    changelog([
      { at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
      { at: '2026-10-01T00:00:01Z', task: '002-b', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
    ]);
    const specDir = path.join(root, '.workbench', 'tasks', '001-a');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify({ phases: [{ name: 'implement', isError: true, error: 'Stopped' }] }));
    await notices.onState({ project, task: tasks[0], status: 'in_progress', state: 'coding' });
    await notices.onState({ project, task: tasks[0], status: 'human_review', state: 'human_review' });
    await notices.flush();
    expect(await texts('002-b')).toEqual([]);

    await notices.onState({ project, task: tasks[0], status: 'done' });
    await notices.flush();
    const [notice] = await texts('002-b');
    expect(notice).toContain('was merged into `main`, your base branch');
    expect(notice).toContain('run `git merge --no-edit main`');
  });

  it('takes the first state machine status after a restart as restored, not as a transition', async () => {
    changelog([
      { at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'human_review', files: ['src/x.ts'] },
      { at: '2026-10-01T00:00:01Z', task: '002-b', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
    ]);
    const specDir = path.join(root, '.workbench', 'tasks', '001-a');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify({ summary: 'Added X', phases: [{ name: 'implement' }] }));
    // Merged after a restart: its machine is created in Human Review, then moves to Done
    await notices.onState({ project, task: tasks[0], status: 'human_review', state: 'human_review' });
    await notices.onState({ project, task: tasks[0], status: 'done', state: 'done' });
    await notices.flush();

    // Only the merge: restored in Human Review, it did not just finish
    expect(await texts('002-b')).toHaveLength(1);
    expect(await texts('002-b')).toEqual([expect.stringMatching(/^Task 001-a .* was merged into `main`, your base branch\./)]);
  });

  it('does not merge a task restored in Done again', async () => {
    tasks[0] = task('001-a', 'done', { prState: 'merged' });
    // Any action on it after a restart creates its machine in Done
    await notices.onState({ project, task: tasks[0], status: 'done', state: 'done' });
    await notices.flush();

    expect(await texts('002-b')).toEqual([]);
  });

  it('does not take a task that changed no files as merged locally', async () => {
    const isMerged = vi.fn(async () => true);
    const noFiles = new TaskNotices({ batchMs: 60_000, isMerged });
    // Its branch has no commits of its own, so it is in `main` (isMerged) without having been merged
    await noFiles.onState({ project, task: tasks[0], status: 'done' });
    await noFiles.flush();
    noFiles.stop();

    expect(isMerged).not.toHaveBeenCalled();
    expect(await texts('002-b')).toEqual([]);
  });

  it('checks the task branch when the changelog names a detached HEAD', async () => {
    changelog([{ at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'human_review', branch: 'HEAD', files: ['src/x.ts'] }]);
    const isMerged = vi.fn(async (_project: Project, _task: Task, _branch: string | undefined, _base: string) => false);
    const detached = new TaskNotices({ batchMs: 60_000, isMerged });
    await detached.onState({ project, task: tasks[0], status: 'done' });
    detached.stop();
    expect(isMerged).toHaveBeenCalledWith(project, expect.objectContaining({ specId: '001-a' }), 'workbench/001-a', 'main');
  });

  it('sends nothing while task messaging is off', async () => {
    const off = new TaskNotices({ batchMs: 60_000, isEnabled: () => false });
    await off.onState({ project, task: tasks[0], status: 'in_progress', state: 'planning' });
    off.onFilesEdited({ project, task: tasks[0], files: ['src/x.ts'] });
    await off.flush();
    off.stop();
    expect(await texts('002-b')).toEqual([]);
  });
});
