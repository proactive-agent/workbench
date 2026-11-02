/**
 * The Puppeteer browser profiles still chosen, so sweeps of profile copies (profile-copy.ts) keep
 * theirs: the one in Settings > Connectors and every task's own pick (TaskMetadata.puppeteerBrowser)
 * that isn't archived. Read from the tasks' task_metadata.json files without blocking (the
 * project store's task scan is synchronous)
 */

import path from 'path';
import { readdir, readFile } from 'fs/promises';
import { projectStore } from '../project-store';
import { getSpecsDir } from '../../shared/constants';
import type { PuppeteerBrowserChoice } from '../../shared/types/browser-profiles';
import type { BrowserChoicesInUse } from './profile-copy';

/** The profiles a project's tasks picked for themselves (archived tasks don't count) */
async function projectTaskChoices(projectPath: string, autoBuildPath: string | undefined): Promise<PuppeteerBrowserChoice[]> {
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
        puppeteerBrowser?: PuppeteerBrowserChoice | null;
        archivedAt?: string;
      } | null;
      const choice = metadata?.puppeteerBrowser;
      return choice && typeof choice.id === 'string' && !metadata?.archivedAt ? choice : null;
    } catch {
      return null;
    }
  }));
  return choices.filter((choice): choice is PuppeteerBrowserChoice => choice !== null);
}

/**
 * The profiles chosen for runs in `projectPath` (Settings and its tasks) and anywhere (Settings and
 * every project's tasks). Best effort: a folder that can't be read counts as choosing nothing
 */
export async function browserChoicesInUse(
  projectPath: string,
  settingsChoice: PuppeteerBrowserChoice | undefined
): Promise<BrowserChoicesInUse> {
  const projects = projectStore.getProjects();
  const settings = settingsChoice ? [settingsChoice] : [];
  const perProject = await Promise.all(projects.map(async (project) => ({
    path: project.path,
    choices: await projectTaskChoices(project.path, project.autoBuildPath),
  })));
  const own = perProject.filter((entry) => entry.path === projectPath).flatMap((entry) => entry.choices);
  return {
    project: [...settings, ...own],
    all: [...settings, ...perProject.flatMap((entry) => entry.choices)],
  };
}
