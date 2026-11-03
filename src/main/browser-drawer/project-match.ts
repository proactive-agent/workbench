/**
 * Which project a Playwright browser session belongs to
 * =====================================================
 *
 * A bound browser's workspace folder is where its MCP server works: a task run's worktree
 * (`<project>/.workbench/worktrees/tasks/<task>`) or the project itself (a task without a
 * worktree), so a session belongs to the project whose folder holds it (the innermost one, for
 * projects inside other projects). A Claude chat's server works in the turn's own temporary
 * folder (insights/playwright-guard.cjs), which the turn registers here for its project while it
 * runs. In WSL mode the folders are the distribution's Linux paths, compared as the Windows paths
 * the app stores (toHostPath: `/mnt/c/x` as `C:\x`, `/home/x` as `\\wsl.localhost\<distro>\home\x`).
 */

import path from 'path';

export interface ProjectLocation {
  id: string;
  path: string;
}

/** Chat turns' Playwright folders -> their project's folder */
const chatWorkspaces = new Map<string, string>();

/** A chat turn's Playwright folder belongs to its project until the returned function is called */
export function registerChatBrowserWorkspace(dir: string, projectPath: string): () => void {
  chatWorkspaces.set(dir, projectPath);
  return () => {
    if (chatWorkspaces.get(dir) === projectPath) chatWorkspaces.delete(dir);
  };
}

/** The chat folders registered now (folder -> project folder) */
export function getChatBrowserWorkspaces(): ReadonlyMap<string, string> {
  return chatWorkspaces;
}

/** A folder for comparison: resolved, without a trailing separator, lower case where case doesn't count */
function normalize(dir: string, caseInsensitive: boolean): string {
  const p = /^[A-Za-z]:[\\/]|^\\\\/.test(dir) ? path.win32 : path.posix;
  // A WSL distribution's folders by either of Windows' names for them (\\wsl$ is the older)
  const resolved = p.resolve(dir).replace(/[\\/]+$/, '').replace(/^\\\\wsl\$\\/i, '\\\\wsl.localhost\\');
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

function isInside(dir: string, base: string): boolean {
  return dir === base || dir.startsWith(base + '/') || dir.startsWith(base + '\\');
}

/**
 * The project a session's workspace folder belongs to, or undefined for a session started
 * elsewhere (another tool's Playwright, the availability probe)
 */
export function sessionProjectId(
  workspaceDir: string | undefined,
  projects: readonly ProjectLocation[],
  chats: ReadonlyMap<string, string> = chatWorkspaces,
  caseInsensitive = false,
): string | undefined {
  if (!workspaceDir) return undefined;
  const dir = normalize(workspaceDir, caseInsensitive);
  let projectDir: string | undefined;
  for (const [chatDir, chatProject] of chats) {
    if (normalize(chatDir, caseInsensitive) === dir) {
      projectDir = normalize(chatProject, caseInsensitive);
      break;
    }
  }
  let best: { id: string; length: number } | undefined;
  for (const project of projects) {
    if (!project.path) continue;
    const base = normalize(project.path, caseInsensitive);
    const matches = projectDir !== undefined ? projectDir === base : isInside(dir, base);
    if (matches && (!best || base.length > best.length)) best = { id: project.id, length: base.length };
  }
  return best?.id;
}
