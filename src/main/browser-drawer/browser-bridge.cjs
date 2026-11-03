// Workbench's browser bridge (the browser drawer's link to Playwright's headless browsers)
//
// Forked by the main process (bridge-process.ts) with Workbench's executable as Node, IPC with
// advanced serialization. It connects to the bound browsers it is given (Playwright's registry
// endpoint) with each browser's own playwright-core (`require(playwrightLib)`, the npx cache of
// the MCP server that launched it), the way Playwright's own dashboard does; disconnecting leaves
// the browser running. It reports their pages, streams the viewed pages as JPEG frames
// (`page.screencast`), sizes a viewed page's viewport to the drawer, and replays the viewer's
// mouse, wheel and keys on it. Plain Node, no packages of its own.
'use strict';

/** session id -> { browser, key } */
const sessions = new Map();
/** page id -> { page, sessionId } */
const pages = new Map();
const pageIds = new WeakMap();
let nextPageId = 1;
/** How long connecting to a browser may take */
const CONNECT_TIMEOUT_MS = 15000;
/** page id -> { viewers: Set<number>, size: {width,height} | null } */
const casts = new Map();
/** viewer id -> page id */
const viewers = new Map();

const send = (message) => {
  try {
    if (process.connected) process.send(message);
  } catch {
    // The main process is gone
  }
};
const log = (message) => send({ type: 'log', message: String(message && message.message ? message.message : message) });

// Commands run one at a time (connects, screencasts, viewport changes); input has its own queue so
// it stays in order without waiting behind a slow navigation
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch(log));
let inputQueue = Promise.resolve();
const enqueueInput = (fn) => (inputQueue = inputQueue.then(fn).catch(() => undefined));

let pagesTimer = null;
function pushPages() {
  if (pagesTimer) return;
  pagesTimer = setTimeout(async () => {
    pagesTimer = null;
    const list = await Promise.all([...pages].map(async ([id, entry]) => ({
      id,
      sessionId: entry.sessionId,
      url: entry.page.url(),
      title: await entry.page.title().catch(() => ''),
    })));
    send({ type: 'pages', pages: list, connected: [...sessions.keys()] });
  }, 100);
}

function addPage(page, sessionId) {
  if (pageIds.has(page)) return;
  const id = `${sessionId}#${nextPageId++}`;
  pageIds.set(page, id);
  pages.set(id, { page, sessionId });
  page.on('close', () => {
    pages.delete(id);
    casts.delete(id);
    pushPages();
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) pushPages();
  });
  page.on('load', pushPages);
  pushPages();
}

function wireContext(context, sessionId) {
  for (const page of context.pages()) addPage(page, sessionId);
  context.on('page', (page) => addPage(page, sessionId));
}

async function connect(session) {
  const key = `${session.endpoint}|${session.playwrightLib}`;
  const previous = sessions.get(session.id);
  if (previous?.key === key) return;
  // The browser moved (another endpoint or playwright-core): the old link and its pages go first
  if (previous) {
    dropSession(session.id);
    await previous.browser.close().catch(() => undefined);
  }
  const playwright = require(session.playwrightLib);
  const browserType = playwright[session.browserName] || playwright.chromium;
  // Bounded: commands run one at a time, so a browser that never answers must not hold up the rest
  const browser = await browserType.connect(session.endpoint, { timeout: CONNECT_TIMEOUT_MS });
  sessions.set(session.id, { browser, key });
  for (const context of browser.contexts()) wireContext(context, session.id);
  browser.on('context', (context) => wireContext(context, session.id));
  browser.on('disconnected', () => {
    if (sessions.get(session.id)?.browser === browser) dropSession(session.id);
  });
  pushPages();
}

/** A new tab in a session's browser (its first context: the one its MCP server uses) */
async function newPage(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  const context = entry.browser.contexts()[0] || (await entry.browser.newContext());
  const page = await context.newPage();
  addPage(page, sessionId);
}

function dropSession(sessionId) {
  sessions.delete(sessionId);
  for (const [id, entry] of pages) {
    if (entry.sessionId !== sessionId) continue;
    pages.delete(id);
    casts.delete(id);
  }
  pushPages();
}

async function setSessions(list) {
  const wanted = new Set(list.map((s) => s.id));
  for (const [id, entry] of sessions) {
    if (wanted.has(id)) continue;
    dropSession(id);
    // A connected client only disconnects; the browser keeps running
    await entry.browser.close().catch(() => undefined);
  }
  for (const session of list) {
    await connect(session).catch((error) => log(`Could not connect to ${session.id}: ${error.message}`));
  }
}

async function startCast(pageId) {
  const entry = pages.get(pageId);
  const cast = casts.get(pageId);
  if (!entry || !cast) return;
  const size = entry.page.viewportSize() || { width: 1280, height: 720 };
  if (cast.size && cast.size.width === size.width && cast.size.height === size.height) return;
  if (cast.size) {
    await entry.page.screencast.stop().catch(() => undefined);
    cast.size = null;
  }
  await entry.page.screencast.start({
    size,
    quality: 80,
    onFrame: ({ data, viewportWidth, viewportHeight }) => {
      const current = casts.get(pageId);
      if (!current || current.viewers.size === 0) return;
      send({ type: 'frame', pageId, viewers: [...current.viewers], data, width: viewportWidth, height: viewportHeight });
    },
  });
  // Only a cast that started counts: one that failed (the page was navigating) is tried again
  cast.size = size;
}

async function stopCast(pageId) {
  const cast = casts.get(pageId);
  if (!cast || cast.viewers.size > 0) return;
  casts.delete(pageId);
  const entry = pages.get(pageId);
  if (entry && cast.size) await entry.page.screencast.stop().catch(() => undefined);
}

async function view(viewerId, pageId, width, height) {
  const previous = viewers.get(viewerId);
  if (previous && previous !== pageId) {
    casts.get(previous)?.viewers.delete(viewerId);
    viewers.delete(viewerId);
    await stopCast(previous);
  }
  const entry = pageId ? pages.get(pageId) : undefined;
  if (!entry) {
    viewers.delete(viewerId);
    return;
  }
  viewers.set(viewerId, pageId);
  // The page fills the drawer: its viewport is the drawer's page area (what the agent sees too)
  if (width > 0 && height > 0) {
    const current = entry.page.viewportSize();
    if (!current || current.width !== width || current.height !== height) {
      await entry.page.setViewportSize({ width, height }).catch((error) => log(error));
    }
  }
  let cast = casts.get(pageId);
  if (!cast) {
    cast = { viewers: new Set(), size: null };
    casts.set(pageId, cast);
  }
  cast.viewers.add(viewerId);
  await startCast(pageId);
}

async function input(pageId, event) {
  const page = pages.get(pageId)?.page;
  if (!page || !event) return;
  const button = ['left', 'right', 'middle'].includes(event.button) ? event.button : 'left';
  switch (event.kind) {
    case 'mousemove':
      await page.mouse.move(event.x, event.y);
      break;
    case 'mousedown':
      await page.mouse.move(event.x, event.y);
      await page.mouse.down({ button, clickCount: event.clickCount || 1 });
      break;
    case 'mouseup':
      await page.mouse.move(event.x, event.y);
      await page.mouse.up({ button, clickCount: event.clickCount || 1 });
      break;
    case 'wheel':
      await page.mouse.move(event.x, event.y);
      await page.mouse.wheel(event.deltaX || 0, event.deltaY || 0);
      break;
    case 'keydown':
      try {
        await page.keyboard.down(event.key);
      } catch {
        // A character Playwright has no key for (another layout): typed as text
        if ([...event.key].length === 1) await page.keyboard.insertText(event.key);
      }
      break;
    case 'keyup':
      await page.keyboard.up(event.key).catch(() => undefined);
      break;
    case 'text':
      await page.keyboard.insertText(String(event.text || ''));
      break;
  }
}

async function navigate(pageId, action, url) {
  const page = pages.get(pageId)?.page;
  if (!page) return;
  const options = { timeout: 30000 };
  if (action === 'back') await page.goBack(options);
  else if (action === 'forward') await page.goForward(options);
  else if (action === 'reload') await page.reload(options);
  else if (action === 'goto' && url) await page.goto(url, options);
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'sessions':
      enqueue(() => setSessions(Array.isArray(message.sessions) ? message.sessions : []));
      break;
    case 'view':
      enqueue(() => view(message.viewerId, message.pageId, Math.round(message.width), Math.round(message.height)));
      break;
    case 'input':
      enqueueInput(() => input(message.pageId, message.event));
      break;
    case 'navigate':
      // Not queued: a slow page must not hold up the other commands
      navigate(message.pageId, message.action, message.url).catch(log);
      break;
    case 'closePage':
      pages.get(message.pageId)?.page.close().catch(log);
      break;
    case 'newPage':
      enqueue(() => newPage(message.sessionId));
      break;
  }
});

// Gone with the main process: disconnect (the browsers keep running)
process.on('disconnect', () => {
  Promise.all([...sessions.values()].map((entry) => entry.browser.close().catch(() => undefined)))
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
