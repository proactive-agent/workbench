/**
 * Test merge of two tasks' work
 * =============================
 *
 * Whether two parallel tasks' changes actually conflict, rather than only touching the same
 * files: `git merge-tree --write-tree` (git 2.38+) merges the two sides in the object store, never
 * in a worktree or index, and exits with 1 when the merge has conflicts.
 *
 * Tasks commit only when they are validated, so a running task's work is mostly uncommitted in
 * its worktree. Each side is snapshotted as a commit without touching the worktree's index or
 * files: a copy of its index (stat data, so unchanged files aren't hashed again) in a temp file
 * (`GIT_INDEX_FILE`, a path from `git rev-parse --git-path` so it is valid where git runs, WSL
 * included), `add -A` (respects .gitignore), `write-tree`, `commit-tree -p HEAD`. A clean worktree
 * is its HEAD. A task without a worktree is its branch tip. The snapshot commits are dangling
 * objects that git's gc removes.
 */
import { copyFile, rm } from 'fs/promises';
import path from 'path';
import type { Project } from '../../shared/types';
import { appLog } from '../app-logger';
import { getTaskWorktreeBranch } from '../../shared/utils/claude-run';
import { toHostPath } from '../platform/shell-runtime';
import { git } from '../utils/git-exec';
import { getIsolatedGitEnv } from '../utils/git-isolation';
import { findTaskWorktree } from '../worktree-paths';

/** A file both sides change in the same place */
export interface TaskConflict {
  file: string;
  /** Where in the first task's version, roughly ("line 40", "lines 40-52, 80-85") */
  lines?: string;
  /** The same for the second task */
  otherLines?: string;
}

/** Two tasks' conflicts, or null when they couldn't be checked */
export type FindConflicts = (project: Pick<Project, 'path'>, specA: string, specB: string) => Promise<TaskConflict[] | null>;

const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_REGIONS = 3;
/** Files whose conflict regions are looked up (the notice lists only a few) */
const MAX_FILES_WITH_LINES = 10;
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Workbench',
  GIT_AUTHOR_EMAIL: 'workbench@localhost',
  GIT_COMMITTER_NAME: 'Workbench',
  GIT_COMMITTER_EMAIL: 'workbench@localhost',
};

const lines = (stdout: string) => stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/** A path git printed (relative to `cwd`, or absolute where git runs) as the app sees it */
function hostPath(cwd: string, printed: string): string {
  return path.isAbsolute(printed) || printed.startsWith('/') ? toHostPath(printed) : path.resolve(cwd, printed);
}

/** The worktree's current state as a commit (its HEAD when nothing changed) */
async function snapshotWorktree(worktree: string): Promise<string> {
  const name = `wb-conflict-check-${process.pid}-${Math.random().toString(36).slice(2)}.index`;
  const [head, headTree, tempIndex, index] = lines((await git(
    ['rev-parse', 'HEAD', 'HEAD^{tree}', '--git-path', name, '--git-path', 'index'],
    { cwd: worktree, isolated: true, timeout: TIMEOUT_MS }
  )).stdout);
  if (!head || !headTree || !tempIndex || !index) throw new Error('git rev-parse printed too little');
  const tempHost = hostPath(worktree, tempIndex);
  const env = { ...getIsolatedGitEnv(), GIT_INDEX_FILE: tempIndex, ...IDENTITY };
  const run = (args: string[]) => git(args, { cwd: worktree, env, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  try {
    try {
      await copyFile(hostPath(worktree, index), tempHost);
    } catch {
      await run(['read-tree', 'HEAD']);
    }
    await run(['add', '-A']);
    const tree = (await run(['write-tree'])).stdout.trim();
    if (tree === headTree) return head;
    return (await run(['commit-tree', tree, '-p', head, '-m', 'Workbench conflict check'])).stdout.trim();
  } finally {
    await rm(tempHost, { force: true }).catch(() => undefined);
  }
}

/** A task's work as a commit: its worktree's state, else its branch tip */
async function taskCommit(project: Pick<Project, 'path'>, specId: string): Promise<string> {
  const worktree = findTaskWorktree(project.path, specId);
  if (worktree) return snapshotWorktree(worktree);
  const { stdout } = await git(['rev-parse', '--verify', '--quiet', `${getTaskWorktreeBranch(specId)}^{commit}`], {
    cwd: project.path,
    isolated: true,
    timeout: TIMEOUT_MS,
  });
  return stdout.trim();
}

function formatRegions(regions: Array<[number, number]>): string | undefined {
  if (regions.length === 0) return undefined;
  const shown = regions.slice(0, MAX_REGIONS).map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`));
  const more = regions.length > shown.length ? `, and ${regions.length - shown.length} more` : '';
  const single = regions.length === 1 && regions[0][0] === regions[0][1];
  return `${single ? 'line' : 'lines'} ${shown.join(', ')}${more}`;
}

/**
 * Where the conflict markers of a merged file are, counted in each side's version: lines outside
 * the conflicts count for both, a conflict's first part for the first side, its last part for the
 * second (a diff3 base part for neither). Rough, since the clean parts hold both sides' changes.
 */
export function conflictRegions(content: string): { a: Array<[number, number]>; b: Array<[number, number]> } {
  const a: Array<[number, number]> = [];
  const b: Array<[number, number]> = [];
  let lineA = 0;
  let lineB = 0;
  let part: 'none' | 'ours' | 'base' | 'theirs' = 'none';
  let startA = 0;
  let startB = 0;
  for (const line of content.split('\n')) {
    if (part === 'none' && /^<{7,}(?: |$)/.test(line)) {
      part = 'ours';
      startA = lineA + 1;
      startB = lineB + 1;
    } else if (part === 'ours' && /^\|{7,}(?: |$)/.test(line)) {
      part = 'base';
    } else if ((part === 'ours' || part === 'base') && /^={7,}$/.test(line.trimEnd())) {
      part = 'theirs';
    } else if (part === 'theirs' && /^>{7,}(?: |$)/.test(line)) {
      a.push([startA, Math.max(startA, lineA)]);
      b.push([startB, Math.max(startB, lineB)]);
      part = 'none';
    } else if (part === 'none') {
      lineA++;
      lineB++;
    } else if (part === 'ours') {
      lineA++;
    } else if (part === 'theirs') {
      lineB++;
    }
  }
  return { a, b };
}

/** Merge the two tasks' work in the object store and collect the conflicts; throws when it can't */
async function testMerge(project: Pick<Project, 'path'>, specA: string, specB: string): Promise<TaskConflict[]> {
  const [a, b] = await Promise.all([taskCommit(project, specA), taskCommit(project, specB)]);
  if (!a || !b) throw new Error(`no commit for ${a ? specB : specA}`);
  let stdout: string;
  try {
    await git(['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', a, b], {
      cwd: project.path,
      isolated: true,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return [];
  } catch (error) {
    // Exit code 1: the merge has conflicts (anything else: an error, or a git older than 2.38)
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code !== 1 || typeof failure.stdout !== 'string') throw error;
    stdout = failure.stdout;
  }
  // -z: the tree, then each conflicted file, NUL-terminated and unquoted
  const [tree, ...files] = stdout.split('\0').filter(Boolean);
  if (!tree || !/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('git merge-tree printed no tree');
  const unique = [...new Set(files)];
  return Promise.all(unique.map(async (file, index): Promise<TaskConflict> => {
    if (index >= MAX_FILES_WITH_LINES) return { file };
    try {
      const { stdout: content } = await git(['cat-file', '-p', `${tree}:${file}`], {
        cwd: project.path,
        isolated: true,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const regions = conflictRegions(content);
      return { file, lines: formatRegions(regions.a), otherLines: formatRegions(regions.b) };
    } catch {
      // Deleted on one side, or too big: the file alone
      return { file };
    }
  }));
}

let loggedFailure = false;

/**
 * The files where the two tasks' work conflicts ([] when it merges cleanly); null when it couldn't
 * be checked (logged once: a git older than 2.38, a task with neither worktree nor branch, ...)
 */
export const findConflicts: FindConflicts = async (project, specA, specB) => {
  try {
    return await testMerge(project, specA, specB);
  } catch (error) {
    if (!loggedFailure) {
      loggedFailure = true;
      appLog.warn('[task-messaging] Test merge of parallel tasks failed, falling back to file overlap notices:', error instanceof Error ? error.message : error);
    }
    return null;
  }
};
