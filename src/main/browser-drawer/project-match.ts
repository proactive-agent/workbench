/**
 * Which project a Playwright browser session belongs to
 * =====================================================
 *
 * Only Claude chats' browsers belong to a project here: the drawer shows nothing else. A chat's
 * browser works in a folder of its own (the chat browser's holder folder, or a turn's temporary
 * folder, insights/playwright-guard.cjs), registered here for its project while it runs. Task runs'
 * browsers (their workspace is the task's worktree or the project) stay headless and unseen, as
 * does any other tool's Playwright. In WSL mode the folders are the distribution's Linux paths, compared as the Windows paths
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


/**
 * The project of a chat's browser, by its registered workspace folder; undefined for every other
 * session (task runs, another tool's Playwright, the availability probe)
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
  if (projectDir === undefined) return undefined;
  return projects.find((project) => project.path && normalize(project.path, caseInsensitive) === projectDir)?.id;
}
