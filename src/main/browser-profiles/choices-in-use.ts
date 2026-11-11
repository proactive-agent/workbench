/**
 * The Playwright browser profiles still chosen, so sweeps of profile copies (profile-copy.ts) keep
 * theirs: the one in Settings > Browser, every task's own pick (TaskMetadata.playwrightBrowser) and
 * every chat's (InsightsModelConfig.playwrightBrowser) that isn't archived. Read from the tasks'
 * task_metadata.json and the chats' files without blocking (the project store's task scan is
 * synchronous). Leaving a chat's pick out removed its profile's saved copy whenever another
 * profile ran, so a chat on a browser the user keeps open lost Playwright
 */

import path from 'path';
import { readdir, readFile } from 'fs/promises';
import { projectStore } from '../project-store';
import { getSpecsDir } from '../../shared/constants';
import type { PlaywrightBrowserChoice } from '../../shared/types/browser-profiles';
import type { BrowserChoicesInUse } from './profile-copy';
import { migrateTaskConnectorFields } from '../../shared/utils/mcp-connectors';
import { InsightsPaths } from '../insights/paths';

/** A stored pick, unless it is unset, Playwright's own Chromium (null) or archived */
function storedChoice(stored: { playwrightBrowser?: PlaywrightBrowserChoice | null; archivedAt?: unknown } | null | undefined): PlaywrightBrowserChoice | null {
  const choice = stored?.playwrightBrowser;
  return choice && typeof choice.id === 'string' && !stored?.archivedAt ? choice : null;
}

/** The profiles a project's tasks picked for themselves (archived tasks don't count) */
async function projectTaskChoices(projectPath: string, autoBuildPath: string | undefined): Promise<PlaywrightBrowserChoice[]> {
  const specsDir = path.join(projectPath, getSpecsDir(autoBuildPath));
  let names: string[];
  try {
    names = await readdir(specsDir);
  } catch {
    return [];
  }
  const choices = await Promise.all(names.map(async (name) => {
    try {
      const metadata = JSON.parse(await readFile(path.join(specsDir, name, 'task_metadata.json'), 'utf-8')) as {
        playwrightBrowser?: PlaywrightBrowserChoice | null;
        archivedAt?: string;
      } | null;
      // A pick stored before the connector moved to Playwright (puppeteerBrowser)
      migrateTaskConnectorFields(metadata as Record<string, unknown> | null);
      return storedChoice(metadata);
    } catch {
      return null;
    }
  }));
  return choices.filter((choice): choice is PlaywrightBrowserChoice => choice !== null);
}

/** The profiles a project's chats picked for themselves (archived chats don't count) */
async function projectChatChoices(projectPath: string): Promise<PlaywrightBrowserChoice[]> {
  const sessionsDir = new InsightsPaths().getSessionsDir(projectPath);
  let names: string[];
  try {
    names = (await readdir(sessionsDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const choices = await Promise.all(names.map(async (name) => {
    try {
      const chat = JSON.parse(await readFile(path.join(sessionsDir, name), 'utf-8')) as {
        modelConfig?: { playwrightBrowser?: PlaywrightBrowserChoice | null };
        archivedAt?: unknown;
      } | null;
      return storedChoice(chat?.modelConfig ? { ...chat.modelConfig, archivedAt: chat.archivedAt } : null);
    } catch {
      return null;
    }
  }));
  return choices.filter((choice): choice is PlaywrightBrowserChoice => choice !== null);
}

/**
 * The profiles chosen for runs in `projectPath` (Settings, its tasks and chats) and anywhere
 * (Settings and every project's tasks and chats). Best effort: a folder that can't be read counts as choosing nothing
 */
export async function browserChoicesInUse(
  projectPath: string,
  settingsChoice: PlaywrightBrowserChoice | undefined
): Promise<BrowserChoicesInUse> {
  const projects = projectStore.getProjects();
  const settings = settingsChoice ? [settingsChoice] : [];
  const perProject = await Promise.all(projects.map(async (project) => ({
    path: project.path,
    choices: [...(await projectTaskChoices(project.path, project.autoBuildPath)), ...(await projectChatChoices(project.path))],
  })));
  const own = perProject.filter((entry) => entry.path === projectPath).flatMap((entry) => entry.choices);
  return {
    project: [...settings, ...own],
    all: [...settings, ...perProject.flatMap((entry) => entry.choices)],
  };
}
