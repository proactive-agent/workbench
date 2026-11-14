/**
 * Test merge of two tasks' work with real git: uncommitted edits count, changes to different
 * parts of a file merge cleanly, the same lines conflict (with their lines), and neither task's
 * worktree or index changes.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../shared/types';

vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));

import { conflictRegions, findConflicts } from '../conflict-check';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

let tmp: string;
let project: Pick<Project, 'path'>;

function worktree(specId: string): string {
  const dir = path.join(project.path, '.workbench', 'worktrees', 'tasks', specId);
  git(project.path, 'worktree', 'add', '-q', '-b', `workbench/${specId}`, dir, 'main');
  return dir;
}

function edit(dir: string, file: string, change: (lines: string[]) => void): void {
  const lines = readFileSync(path.join(dir, file), 'utf-8').split('\n');
  change(lines);
  writeFileSync(path.join(dir, file), lines.join('\n'));
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'conflict-check-'));
  const repo = path.join(tmp, 'repo');
  mkdirSync(repo);
  project = { path: repo };
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, '.gitignore'), '.workbench/\n');
  writeFileSync(path.join(repo, 'shared.ts'), `${numbered(40).join('\n')}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
});

afterEach(() => {
  // Windows: a git process the test started may still hold a file in it for a moment (EPERM)
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('findConflicts', () => {
  it('merges uncommitted changes to different parts of a file cleanly, and leaves both worktrees as they were', async () => {
    const a = worktree('001-a');
    const b = worktree('002-b');
    edit(a, 'shared.ts', (lines) => { lines[2] = 'A changed line 3'; });
    edit(b, 'shared.ts', (lines) => { lines[30] = 'B changed line 31'; });
    writeFileSync(path.join(b, 'new.ts'), 'new\n');
    const statusBefore = [git(a, 'status', '--porcelain'), git(b, 'status', '--porcelain')];

    expect(await findConflicts(project, '001-a', '002-b')).toEqual([]);
    expect([git(a, 'status', '--porcelain'), git(b, 'status', '--porcelain')]).toEqual(statusBefore);
    expect(git(b, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('finds same-line edits, committed on one side and uncommitted on the other, with the lines on each side', async () => {
    const a = worktree('001-a');
    const b = worktree('002-b');
    edit(a, 'shared.ts', (lines) => { lines.splice(9, 2, 'A 10', 'A 11', 'A 11b'); });
    git(a, 'commit', '-q', '-am', 'a');
    edit(b, 'shared.ts', (lines) => { lines[9] = 'B 10'; });

    const conflicts = await findConflicts(project, '001-a', '002-b');
    expect(conflicts).toEqual([{ file: 'shared.ts', lines: 'lines 10-12', otherLines: 'lines 10-11' }]);
  });

  it("uses a task's branch when it has no worktree, and new files both sides add conflict too", async () => {
    const a = worktree('001-a');
    writeFileSync(path.join(a, 'added.ts'), 'from A\n');
    git(a, 'add', '.');
    git(a, 'commit', '-q', '-m', 'a');
    git(project.path, 'worktree', 'remove', '--force', a);
    const b = worktree('002-b');
    writeFileSync(path.join(b, 'added.ts'), 'from B\n');

    expect(await findConflicts(project, '001-a', '002-b')).toEqual([{ file: 'added.ts', lines: 'line 1', otherLines: 'line 1' }]);
  });

  it("can't check a task with neither worktree nor branch", async () => {
    worktree('002-b');
    expect(await findConflicts(project, '001-missing', '002-b')).toBeNull();
  });
});

describe('conflictRegions', () => {
  it("counts each side's lines, skipping a diff3 base part", () => {
    const merged = ['a', '<<<<<<< x', 'ours 1', 'ours 2', '||||||| base', 'base', '=======', 'theirs', '>>>>>>> y', 'b', '<<<<<<< x', '=======', 't', '>>>>>>> y', ''].join('\n');
    expect(conflictRegions(merged)).toEqual({ a: [[2, 3], [5, 5]], b: [[2, 2], [4, 4]] });
  });
});
