/**
 * The project's task changelog (.workbench/changelog.jsonl):
 * - the task hooks write an entry for every state a task enters, with the files its branch
 *   changes, and one entry for the files its session starts editing
 * - each task's prompt lists the other tasks' unmerged changes from it
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import type { Project, Task } from '../../shared/types';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));
const worktrees = new Map<string, string>();
vi.mock('../worktree-paths', () => ({ findTaskWorktree: (_projectPath: string, specId: string) => worktrees.get(specId) ?? null }));

import { taskHooks } from '../task-hooks';
import { taskSessionName } from '../../shared/utils/task-messaging';
import { buildParallelTasksPrompt, foldTaskChangelog, parseTaskChangelog, type TaskChangelogEntry } from '../task-changelog';
import { flushTaskChangelog, registerTaskChangelog } from '../task-changelog-writer';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'task-changelog-'));
});

afterEach(() => {
  worktrees.clear();
  rmSync(tmp, { recursive: true, force: true });
});

const at = (minute: number) => `2026-10-11T10:${String(minute).padStart(2, '0')}:00.000Z`;

describe('foldTaskChangelog', () => {
  it("keeps each task's latest state, and edits add to the files of its last state entry", () => {
    const entries: TaskChangelogEntry[] = [
      { at: at(1), task: '001-a', title: 'A', event: 'state', status: 'in_progress', state: 'coding', files: [] },
      { at: at(2), task: '001-a', event: 'edit', files: ['src/a.ts'] },
      { at: at(3), task: '002-b', event: 'state', status: 'queue' },
      { at: at(4), task: '001-a', event: 'edit', files: ['src/a.ts', 'src/b.ts'] },
      { at: at(5), task: '002-b', event: 'state', status: 'backlog', files: [] },
    ];
    const tasks = foldTaskChangelog(entries);
    expect(tasks.get('001-a')).toMatchObject({ title: 'A', status: 'in_progress', state: 'coding', files: ['src/a.ts', 'src/b.ts'], updatedAt: at(4) });
    expect(tasks.get('002-b')).toMatchObject({ status: 'backlog', files: [] });

    // The branch's full diff at review replaces the edits
    entries.push({ at: at(6), task: '001-a', event: 'state', status: 'human_review', state: 'human_review', files: ['src/a.ts'] });
    expect(foldTaskChangelog(entries).get('001-a')?.files).toEqual(['src/a.ts']);
  });

  it('skips malformed lines', () => {
    const content = `${JSON.stringify({ at: at(1), task: '001-a', event: 'state', status: 'queue' })}\n{"at":"cut short\n\n`;
    expect(parseTaskChangelog(content)).toHaveLength(1);
  });
});

describe('buildParallelTasksPrompt', () => {
  it('lists the other tasks with unmerged changes that still exist', async () => {
    const specsDir = path.join(tmp, 'tasks');
    for (const id of ['001-self', '002-coding', '003-review', '004-done', '005-planning']) mkdirSync(path.join(specsDir, id), { recursive: true });
    const changelog = path.join(tmp, 'changelog.jsonl');
    const entries: TaskChangelogEntry[] = [
      { at: at(1), task: '001-self', event: 'state', status: 'in_progress', files: ['src/self.ts'] },
      { at: at(2), task: '002-coding', title: 'Add "auth"', event: 'state', status: 'in_progress', state: 'coding', files: [] },
      { at: at(3), task: '002-coding', event: 'edit', files: ['src/auth.ts'] },
      { at: at(4), task: '003-review', title: 'Review me', event: 'state', status: 'human_review', state: 'human_review', files: [] },
      { at: at(5), task: '004-done', event: 'state', status: 'done', files: ['src/done.ts'] },
      { at: at(6), task: '005-planning', event: 'state', status: 'backlog' },
      { at: at(7), task: '006-deleted', event: 'state', status: 'in_progress', files: ['src/gone.ts'] },
    ];
    writeFileSync(changelog, entries.map((entry) => JSON.stringify(entry)).join('\n'));

    const prompt = await buildParallelTasksPrompt(changelog, '001-self', specsDir);
    expect(prompt).toContain(changelog);
    expect(prompt).toContain(`- \`002-coding\` "Add 'auth'", In Progress (coding): \`src/auth.ts\``);
    expect(prompt).toContain('- `003-review` "Review me", Human Review: no file changes yet');
    for (const hidden of ['src/self.ts', '004-done', '005-planning', '006-deleted']) expect(prompt).not.toContain(hidden);
  });

  it("names each task's session and points at the live tools when task messaging is on", async () => {
    const specsDir = path.join(tmp, 'tasks');
    mkdirSync(path.join(specsDir, '002-coding'), { recursive: true });
    const changelog = path.join(tmp, 'changelog.jsonl');
    writeFileSync(changelog, JSON.stringify({ at: at(1), task: '002-coding', event: 'state', status: 'in_progress', files: ['src/a.ts'] }));

    const prompt = await buildParallelTasksPrompt(changelog, '001-self', specsDir, changelog, { projectId: 'p1', tools: true });
    expect(prompt).toContain(`- \`002-coding\`, session \`${taskSessionName('p1', '002-coding')}\`, In Progress`);
    expect(prompt).toContain('`list_parallel_tasks` for the live picture');
    expect(prompt).toContain('agree with that task via `message_task` on who changes what');
    expect(prompt).toContain('sends a `[Workbench]` notice naming the file and lines when your changes actually conflict');
    const plain = await buildParallelTasksPrompt(changelog, '001-self', specsDir);
    expect(plain).not.toContain('session `');
    expect(plain).not.toContain('list_parallel_tasks');
    expect(plain).not.toContain('message_task');
    // Shared files are fine: only edits to the same lines conflict
    for (const text of [prompt, plain]) {
      expect(text).toContain('Edit whatever files your task needs, including files other tasks change');
      expect(text).not.toContain('leave those files alone');
    }
  });

  it('says so when no other task has unmerged changes, also without a changelog yet', async () => {
    const prompt = await buildParallelTasksPrompt(path.join(tmp, 'missing.jsonl'), '001-self', tmp);
    expect(prompt).toContain('No other task has unmerged changes right now.');
  });
});

describe('task changelog writer', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  let unregister: () => void;

  beforeEach(() => {
    unregister = registerTaskChangelog();
  });

  afterEach(() => {
    unregister();
  });

  const readEntries = (project: Project) =>
    parseTaskChangelog(readFileSync(path.join(project.path, '.workbench', 'changelog.jsonl'), 'utf-8'));

  it("logs each state with the branch's changed files, and new edits once", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const repo = path.join(tmp, 'repo');
      mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'config', 'commit.gpgsign', 'false');
      writeFileSync(path.join(repo, 'README.md'), 'base\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'base');
      const worktree = path.join(tmp, 'wt');
      git(repo, 'worktree', 'add', '-q', '-b', 'workbench/001-a', worktree, 'main');
      worktrees.set('001-a', worktree);

      const project = { id: 'p1', path: repo, autoBuildPath: '.workbench', settings: { mainBranch: 'main' } } as unknown as Project;
      const task = { id: 't1', specId: '001-a', title: 'Task A', metadata: { baseBranch: 'main' } } as unknown as Task;

      taskHooks.emit('state', { project, task, status: 'in_progress', state: 'planning' });
      taskHooks.emit('state', { project, task, status: 'in_progress', state: 'planning' });
      taskHooks.emit('files-edited', { project, task, files: ['src/a.ts'] });
      taskHooks.emit('files-edited', { project, task, files: ['src/b.ts', 'src/a.ts'] });
      await flushTaskChangelog();

      // Committed and untracked changes; Workbench's own files are left out
      mkdirSync(path.join(worktree, 'src'));
      mkdirSync(path.join(worktree, '.workbench'));
      writeFileSync(path.join(worktree, 'src', 'a.ts'), 'a\n');
      writeFileSync(path.join(worktree, '.workbench', 'x.json'), '{}\n');
      git(worktree, 'add', 'src/a.ts');
      git(worktree, 'commit', '-q', '-m', 'a');
      writeFileSync(path.join(worktree, 'src', 'c.ts'), 'c\n');
      taskHooks.emit('state', { project, task, status: 'human_review', state: 'human_review' });
      // Already in the branch's diff: no new edit entry
      taskHooks.emit('files-edited', { project, task, files: ['src/c.ts'] });
      await flushTaskChangelog();

      expect(readEntries(project).map(({ at: _at, ...entry }) => entry)).toEqual([
        { task: '001-a', title: 'Task A', event: 'state', status: 'in_progress', state: 'planning', branch: 'workbench/001-a', files: [] },
        { task: '001-a', title: 'Task A', event: 'edit', files: ['src/a.ts', 'src/b.ts'] },
        { task: '001-a', title: 'Task A', event: 'state', status: 'human_review', state: 'human_review', branch: 'workbench/001-a', files: ['src/a.ts', 'src/c.ts'] },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs edits on their own after a short wait, and skips projects without .workbench', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const project = { id: 'p2', path: path.join(tmp, 'p2'), autoBuildPath: '.workbench', settings: {} } as unknown as Project;
      const task = { id: 't2', specId: '002-b', title: 'Task B', metadata: { useWorktree: false } } as unknown as Task;
      taskHooks.emit('files-edited', { project, task, files: ['x.ts'] });
      vi.advanceTimersByTime(3000);
      await flushTaskChangelog();
      expect(readEntries(project)).toEqual([expect.objectContaining({ task: '002-b', event: 'edit', files: ['x.ts'] })]);

      const uninitialized = { id: 'p3', path: path.join(tmp, 'p3'), autoBuildPath: '', settings: {} } as unknown as Project;
      taskHooks.emit('state', { project: uninitialized, task, status: 'queue' });
      await flushTaskChangelog();
      expect(() => readFileSync(path.join(tmp, 'p3', '.workbench', 'changelog.jsonl'))).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
