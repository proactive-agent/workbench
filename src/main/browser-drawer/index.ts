/**
 * The browser drawer's service (browser-drawer-service.ts), for the app's projects
 */

import { projectStore } from '../project-store';
import { BrowserDrawerService } from './browser-drawer-service';

export const browserDrawer = new BrowserDrawerService({
  getProjects: () => projectStore.getProjects().map((project) => ({ id: project.id, path: project.path })),
});

