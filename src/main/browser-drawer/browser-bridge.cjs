// Workbench's browser bridge (the browser drawer's link to Playwright's headless browsers)
//
// Started by the main process (bridge-process.ts): natively with Workbench's executable as Node,
// in WSL mode with the distribution's node (the browsers, their registry and sockets are there).
// Messages go over stdin/stdout as length-prefixed JSON headers with optional bytes (a frame's
// JPEG), the codec of bridge-framing.ts; stdout carries nothing else (console output goes to
// stderr), and the bridge exits when stdin ends (Workbench is gone). It connects to the bound
// browsers it is given (Playwright's registry endpoint) with each browser's own playwright-core (`require(playwrightLib)`, the npx cache of
// the MCP server that launched it), the way Playwright's own dashboard does; disconnecting leaves
// the browser running. It reports their pages, streams the viewed pages as JPEG frames
// (`page.screencast`, one at a time: the next goes once the drawer drew the last), sizes a viewed page's viewport to the drawer, gives every page Workbench's
// theme as its `prefers-color-scheme`, and replays the viewer's mouse, wheel and keys on it; it also says which registry endpoints answer (`probe`), for WSL
// mode, where the main process can't reach the sockets. Plain Node, no packages of its own.
'use strict';
const net = require('net');

/** session id -> { browser, key } */
const sessions = new Map();
/** page id -> { page, sessionId } */
const pages = new Map();
const pageIds = new WeakMap();
let nextPageId = 1;
/** A navigation that never loads a page (a download, a 204) stops counting as loading after this */
const LOADING_LIMIT_MS = 60000;
/** How long connecting to a browser may take */
const CONNECT_TIMEOUT_MS = 15000;
/** How long a viewport change or a screencast's start or stop may hold up the commands after it */
const COMMAND_TIMEOUT_MS = 5000;
/** How long one input event may take before the page's next one goes (a page that never answers can't hold up its input) */
const INPUT_TIMEOUT_MS = 5000;
/** How long a frame may wait for the drawer to draw it before the next one goes anyway */
const FRAME_ACK_TIMEOUT_MS = 1000;
/**
 * Pages whose address has this are Workbench's own (a Chromium browser's extensions page, opened in
 * the background to list and switch its extensions: EXTENSIONS_HELPER_MARK in extensions.ts), never listed
 */
const HELPER_PAGE_MARK = '#workbench-extensions';
const isHelperPage = (page) => page.url().includes(HELPER_PAGE_MARK);
/** A viewed page's resize taking longer than this is a background tab's (it resizes once in front) */
const RESIZE_STALL_MS = 300;
/**
 * page id -> { viewers: Map<viewer id, scale>, size: the frame size asked for | null, sending: the
 * frame the drawer is drawing | null, next: the newest frame waiting for it | null }. Frames are
 * asked at the viewport times the largest viewer's devicePixelRatio, so they are sharp on HiDPI
 * screens (browsers render that many pixels only when launched for it: mcp-config.ts). One frame
 * is on its way at a time and frames waiting meanwhile are replaced by newer ones; each frame's
 * screencast acknowledgement waits for that, so the browser makes no more frames than the drawer
 * draws (instead of flooding the main process and the window)
 */
const casts = new Map();
/** viewer id -> page id */
const viewers = new Map();
/** Workbench's theme, which every page gets as its `prefers-color-scheme` (null: the browser's own) */
let colorScheme = null;

// stdout is the message channel: anything else printed goes to stderr
const writeOut = process.stdout.write.bind(process.stdout);
console.log = console.info = console.debug = (...args) => console.error(...args);
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);

/** One message as bytes (bridge-framing.ts's codec): a Uint8Array field travels as raw bytes */
function encode(message) {
  let bytes = null;
  const header = {};
  for (const [key, value] of Object.entries(message)) {
    if (value instanceof Uint8Array && !bytes) {
      bytes = value;
      header.$bytes = key;
    } else {
      header[key] = value;
    }
  }
  const json = Buffer.from(JSON.stringify(header), 'utf-8');
  const prefix = Buffer.alloc(10);
  prefix[0] = 0x57;
  prefix[1] = 0x42;
  prefix.writeUInt32BE(json.length, 2);
  prefix.writeUInt32BE(bytes ? bytes.length : 0, 6);
  return Buffer.concat(bytes ? [prefix, json, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)] : [prefix, json]);
}

let outputClosed = false;
process.stdout.on('error', () => {
  outputClosed = true;
});
const send = (message) => {
  if (outputClosed) return;
  try {
    writeOut(encode(message));
  } catch {
    // Workbench is gone
  }
};
const log = (message) => send({ type: 'log', message: String(message && message.message ? message.message : message) });

// Commands run one at a time (connects, screencasts, viewport changes); input has a queue per
// page (inputQueues) so it stays in order without waiting behind a slow navigation or another page
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch(log));

/** A promise's result, or `fallback` once it took `ms` (it may still settle later; a rejection passes through) */
function bounded(promise, ms, fallback) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

let pagesTimer = null;
function pushPages() {
  if (pagesTimer) return;
  pagesTimer = setTimeout(async () => {
    pagesTimer = null;
    // Not a popup still being prepared (see firefoxExtensionAction)
    const list = await Promise.all([...pages].filter(([, entry]) => !isHelperPage(entry.page) && !entry.hidden).map(async ([id, entry]) => ({
      id,
      sessionId: entry.sessionId,
      url: entry.page.url(),
      title: entry.title ?? (await entry.page.title().catch(() => '')),
      loading: entry.loading === true,
      // A popup's size: its own (Chromium's sizes itself to its content), else the one it was given
      ...(entry.popup ? { popup: { ...(entry.page.viewportSize() || { width: 0, height: 0 }), ...entry.popup } } : {}),
    })));
    send({ type: 'pages', pages: list, connected: [...sessions.keys()] });
  }, 100);
}

/**
 * A page's viewport in CSS pixels: the one set, or for a page whose viewport can't be set (a
 * Firefox extension page under WebDriver BiDi) the one it has
 */
function pageViewport(entry) {
  return entry.viewport || entry.page.viewportSize();
}

/** Give a page Workbench's theme (some browsers can't emulate it: their pages keep their own) */
function applyColorScheme(page) {
  if (colorScheme) page.emulateMedia({ colorScheme }).catch(() => undefined);
}

function addPage(page, sessionId, popup) {
  if (pageIds.has(page) || isHelperPage(page)) return;
  const id = `${sessionId}#${nextPageId++}`;
  pageIds.set(page, id);
  const entry = { page, sessionId, loading: false, loadingTimer: null, ...(popup ? { popup } : {}) };
  pages.set(id, entry);
  applyColorScheme(page);
  // Loading: from the main frame's navigation request until the page's load event (or the request
  // failing, or a stop). A navigation that never loads a page (a download, a 204) ends after a while
  const setLoading = (loading) => {
    if (entry.loadingTimer) clearTimeout(entry.loadingTimer);
    entry.loadingTimer = loading ? setTimeout(() => setLoading(false), LOADING_LIMIT_MS) : null;
    if (entry.loading === loading) return;
    entry.loading = loading;
    pushPages();
  };
  entry.setLoading = setLoading;
  const mainNavigation = (request) => {
    try {
      return request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      // A request of a frame that is gone
      return false;
    }
  };
  // Only the navigation in flight ends the loading: a replaced one fails (aborted) after the
  // request of the one that replaced it
  page.on('request', (request) => {
    if (!mainNavigation(request)) return;
    entry.navigation = request;
    setLoading(true);
  });
  page.on('requestfailed', (request) => {
    if (request === entry.navigation) setLoading(false);
  });
  page.on('load', () => {
    setLoading(false);
    restartSilentCast(id);
  });
  page.on('close', () => forgetPage(id));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) pushPages();
  });
  page.on('load', pushPages);
  pushPages();
  return id;
}

/** A page that closed goes from the drawer */
function forgetPage(id) {
  const entry = pages.get(id);
  if (!entry) return;
  if (entry.loadingTimer) clearTimeout(entry.loadingTimer);
  pages.delete(id);
  dropCast(id);
  dropInput(id);
  cursorLookups.delete(id);
  pushPages();
}

/**
 * Close a page. A Firefox extension page under WebDriver BiDi would close without a word (no event
 * of a privileged page comes: Playwright would keep it, for the drawer and the chat's Playwright), so
 * it leaves its extension page for a blank one first, and goes from the drawer at once
 */
async function closePage(id) {
  const entry = pages.get(id);
  if (!entry) return;
  if (!entry.privileged) return entry.page.close();
  forgetPage(id);
  await bounded(entry.page.goto('about:blank', { waitUntil: 'commit', timeout: COMMAND_TIMEOUT_MS }).catch(() => undefined), COMMAND_TIMEOUT_MS);
  await entry.page.close().catch(() => undefined);
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
  sessions.set(session.id, { browser, key, bidi: session.bidi === true });
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
    dropCast(id);
    dropInput(id);
    cursorLookups.delete(id);
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

/** Send a page's frame to its viewers; `done` acknowledges it to the browser once it is drawn */
function sendFrame(pageId, cast, frame, done) {
  send({ type: 'frame', pageId, viewers: [...cast.viewers.keys()], ...frame });
  cast.sending = { done, timer: setTimeout(() => frameDrawn(pageId), FRAME_ACK_TIMEOUT_MS) };
}

/** A viewer drew the page's frame (or it took too long): the newest waiting frame goes next */
function frameDrawn(pageId) {
  const cast = casts.get(pageId);
  if (!cast || !cast.sending) return;
  clearTimeout(cast.sending.timer);
  cast.sending.done();
  cast.sending = null;
  const next = cast.next;
  cast.next = null;
  if (!next) return;
  if (cast.viewers.size > 0) sendFrame(pageId, cast, next.frame, next.done);
  else next.done();
}

/** A cast ends: its frames on their way or waiting are acknowledged */
function dropCast(pageId) {
  const cast = casts.get(pageId);
  if (!cast) return;
  casts.delete(pageId);
  if (cast.sending) {
    clearTimeout(cast.sending.timer);
    cast.sending.done();
  }
  cast.next?.done();
  cast.sending = cast.next = null;
}

async function startCast(pageId) {
  const entry = pages.get(pageId);
  const cast = casts.get(pageId);
  if (!entry || !cast) return;
  const viewport = pageViewport(entry) || { width: 1280, height: 720 };
  const scale = Math.max(1, ...cast.viewers.values());
  const size = { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
  if (cast.size && cast.size.width === size.width && cast.size.height === size.height) return;
  if (cast.size) {
    await bounded(entry.page.screencast.stop().catch(() => undefined), COMMAND_TIMEOUT_MS);
    cast.size = null;
  }
  const started = await bounded(
    entry.page.screencast
      .start({
        size,
        // The best JPEG quality: lower ones blur small text (frames are local, so their size matters little)
        quality: 100,
        onFrame: ({ data, viewportWidth, viewportHeight }) => {
          const current = casts.get(pageId);
          if (!current || current.viewers.size === 0) return;
          current.framed = true;
          // A frame of the window's size, not the page's: dropped while the viewport is set again
          if (staleChromiumFrame(pageId, entry, viewportWidth, viewportHeight)) return;
          // The viewport in CSS pixels (Firefox reports the frame's device pixels as its viewport)
          const css = pageViewport(entry) || { width: viewportWidth, height: viewportHeight };
          const frame = { data, width: css.width, height: css.height };
          // Acknowledged to the browser once drawn, or once a newer frame replaced it
          return new Promise((done) => {
            if (!current.sending) {
              sendFrame(pageId, current, frame, done);
              return;
            }
            current.next?.done();
            current.next = { frame, done };
          });
        },
      })
      .then(() => true),
    COMMAND_TIMEOUT_MS,
    false
  );
  // Only a cast that started counts: one that failed (the page was navigating: a browser just
  // opened is still loading its homepage) is tried again shortly, while the page is viewed
  if (started) {
    cast.size = size;
    cast.retries = 0;
    cast.framed = false;
    return;
  }
  log(`The screencast of ${pageId} didn't start; trying again`);
  retryCast(pageId);
}

/** How long after setting a page's viewport again its frames may still be of the window's size */
const VIEWPORT_RESET_GRACE_MS = 1000;
/** How many times in a row it is set again before such frames are shown as they come (it never helped) */
const VIEWPORT_RESET_TRIES = 3;

/**
 * Chromium: once a page's tab was hidden while its screencast ran (another tab came to the front:
 * one Claude or an extension opened, a tab switch) and is shown again, its frames are of the
 * browser window's size rather than the page's viewport (the page itself keeps its viewport), so
 * the drawer shows it scaled. Setting the viewport again brings them back, but only a change
 * counts: one pixel wider, then back. Whether this frame is such a one (the drawer leaves it out)
 */
function staleChromiumFrame(pageId, entry, viewportWidth, viewportHeight) {
  if (entry.keepsViewport || sessions.get(entry.sessionId)?.browser.browserType?.().name() !== 'chromium') return false;
  const viewport = entry.page.viewportSize();
  if (!viewport || (Math.abs(viewportWidth - viewport.width) <= 1 && Math.abs(viewportHeight - viewport.height) <= 1)) {
    entry.viewportResets = 0;
    return false;
  }
  if ((entry.viewportResets ?? 0) >= VIEWPORT_RESET_TRIES) return false;
  const now = Date.now();
  if (!entry.viewportResetAt || now - entry.viewportResetAt > VIEWPORT_RESET_GRACE_MS) {
    entry.viewportResetAt = now;
    entry.viewportResets = (entry.viewportResets ?? 0) + 1;
    enqueue(async () => {
      const current = entry.page.viewportSize();
      if (!current || !pages.has(pageId)) return;
      await bounded(entry.page.setViewportSize({ width: current.width + 1, height: current.height }).catch(() => undefined), COMMAND_TIMEOUT_MS);
      await bounded(entry.page.setViewportSize(current).catch(() => undefined), COMMAND_TIMEOUT_MS);
      entry.viewportResetAt = Date.now();
    });
  }
  return true;
}

/** How often, and how many times, a screencast that didn't start is tried again */
const CAST_RETRY_MS = 500;
const CAST_RETRIES = 20;

function retryCast(pageId) {
  const cast = casts.get(pageId);
  if (!cast || cast.viewers.size === 0 || (cast.retries ?? 0) >= CAST_RETRIES) return;
  cast.retries = (cast.retries ?? 0) + 1;
  setTimeout(() => enqueue(() => (casts.get(pageId) === cast && !cast.size ? startCast(pageId) : undefined)), CAST_RETRY_MS);
}

/**
 * A viewed page whose screencast started while it was navigating may never send a frame: once its
 * new document loads, a cast without frames yet starts again
 */
function restartSilentCast(pageId) {
  const cast = casts.get(pageId);
  if (!cast || cast.viewers.size === 0 || !cast.size || cast.framed) return;
  const entry = pages.get(pageId);
  enqueue(async () => {
    if (casts.get(pageId) !== cast || cast.framed || !entry) return;
    await bounded(entry.page.screencast.stop().catch(() => undefined), COMMAND_TIMEOUT_MS);
    cast.size = null;
    await startCast(pageId);
  });
}

async function stopCast(pageId) {
  const cast = casts.get(pageId);
  if (!cast || cast.viewers.size > 0) return;
  dropCast(pageId);
  const entry = pages.get(pageId);
  if (entry && cast.size) await bounded(entry.page.screencast.stop().catch(() => undefined), COMMAND_TIMEOUT_MS);
}

async function view(viewerId, pageId, width, height, scale) {
  // A window that starts viewing a page shows the arrow until told: the page's cursor is sent again
  const lookup = cursorLookups.get(pageId);
  if (lookup && viewers.get(viewerId) !== pageId) lookup.cursor = 'default';
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
  // A tab the user switches to becomes the browser's active one, as a click on a tab would:
  // Firefox resizes a background tab only once it is in front, so setting its viewport took the
  // command's whole timeout. Not awaited: the tab is active at once, Firefox answers later. Only
  // on a switch: the agent's tab, in front meanwhile, stays there while the drawer resizes
  const switched = previous !== pageId;
  // Not a popup's: the tab it opened for stays active (see firefoxExtensionAction)
  if (switched && !entry.popup) entry.page.bringToFront().catch(() => undefined);
  // The page fills the drawer: its viewport is the drawer's page area (what the agent sees too)
  if (width > 0 && height > 0 && !entry.keepsViewport) {
    const current = entry.page.viewportSize();
    if (!current || current.width !== width || current.height !== height) {
      const resized = entry.page.setViewportSize({ width, height }).catch((error) => log(error));
      // A resize that stalls: another tab came to the front since (Claude opened or picked one).
      // Never a popup's: the page it opened for stays in front
      if (!switched && !entry.popup && !(await bounded(resized.then(() => true), RESIZE_STALL_MS, false))) {
        entry.page.bringToFront().catch(() => undefined);
      }
      await bounded(resized, COMMAND_TIMEOUT_MS);
    }
  }
  let cast = casts.get(pageId);
  if (!cast) {
    cast = { viewers: new Map(), size: null, sending: null, next: null };
    casts.set(pageId, cast);
  }
  cast.viewers.set(viewerId, Number.isFinite(scale) && scale >= 1 ? Math.min(scale, 2) : 1);
  await startCast(pageId);
}

/** page id -> { events: its input waiting to be replayed, in order; running } */
const inputQueues = new Map();

/** A page's input goes with it; copies still waiting are answered (nothing was selected) */
function dropInput(pageId) {
  const queue = inputQueues.get(pageId);
  inputQueues.delete(pageId);
  for (const event of queue?.events ?? []) {
    if (event.kind === 'copy') send({ type: 'copied', id: event.id, text: '' });
  }
}

/**
 * Queue a viewer's input for its page. Mouse moves and wheel steps waiting behind a slow one are
 * merged into the newest (a busy page answers each event late: replaying every move of the
 * pointer would hold a click up for seconds)
 */
function queueInput(pageId, event) {
  if (!event || !pages.has(pageId)) return;
  let queue = inputQueues.get(pageId);
  if (!queue) {
    queue = { events: [], running: false };
    inputQueues.set(pageId, queue);
  }
  const last = queue.events[queue.events.length - 1];
  if (last && last.kind === 'mousemove' && event.kind === 'mousemove') {
    queue.events[queue.events.length - 1] = event;
  } else if (last && last.kind === 'wheel' && event.kind === 'wheel') {
    queue.events[queue.events.length - 1] = {
      ...event,
      deltaX: (last.deltaX || 0) + (event.deltaX || 0),
      deltaY: (last.deltaY || 0) + (event.deltaY || 0),
    };
  } else {
    queue.events.push(event);
  }
  if (!queue.running) void replayInput(pageId, queue);
}

/** How long one frame may take to say what is selected in it (a busy frame is left out) */
const SELECTION_TIMEOUT_MS = 1000;

/**
 * The text selected in a page, as its browser would copy it: in the focused frame (followed from the
 * top through each frame's focused frame element), the focused text field's selection (looking
 * into shadow roots; a field without selection offsets, email or number, through the document's
 * selection, which Chromium fills from it), else the document's. Password fields are never copied
 */
async function selectedText(page) {
  const read = () => {
    let el = document.activeElement;
    let root = document;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      root = el.shadowRoot;
      el = el.shadowRoot.activeElement;
    }
    const selection = () => String((root.getSelection ? root.getSelection() : null) ?? window.getSelection() ?? '');
    if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) return { inFrame: true, text: selection() };
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
      if (el.type === 'password') return { inFrame: false, text: '' };
      let start = null;
      let end = null;
      try {
        start = el.selectionStart;
        end = el.selectionEnd;
      } catch {
        // No selection offsets for this kind of field
      }
      return { inFrame: false, text: typeof start === 'number' && typeof end === 'number' ? el.value.slice(start, end) : selection() };
    }
    return { inFrame: false, text: selection() };
  };
  let frame = page.mainFrame();
  for (let depth = 0; frame && depth < 8; depth++) {
    const result = await bounded(frame.evaluate(read).catch(() => null), SELECTION_TIMEOUT_MS, null);
    if (!result) return '';
    if (!result.inFrame) return result.text;
    // The child frame whose element has the focus
    let next = null;
    for (const child of frame.childFrames()) {
      const element = await child.frameElement().catch(() => null);
      if (!element) continue;
      const focused = await bounded(element.evaluate((e) => e === document.activeElement).catch(() => false), SELECTION_TIMEOUT_MS, false);
      await element.dispose().catch(() => undefined);
      if (focused) {
        next = child;
        break;
      }
    }
    if (!next) return result.text;
    frame = next;
  }
  return '';
}

async function replayInput(pageId, queue) {
  queue.running = true;
  while (queue.events.length > 0) {
    const event = queue.events.shift();
    await bounded(input(pageId, event).catch(() => undefined), INPUT_TIMEOUT_MS);
    if (POINTER_EVENTS.has(event.kind)) noteCursor(pageId, event.x, event.y);
    // A click may change what a popup shows (another of its views): as in the browser, it resizes
    // (not a Firefox popup: its tab answers no measuring once behind the page's)
    const entry = pages.get(pageId);
    if (event.kind === 'mouseup' && entry?.popup && !entry.privileged && !entry.mouseOnly) void settlePopupSize(pageId);
  }
  queue.running = false;
}

// The cursor the page asks for where the mouse is: the drawer shows the page as frames on a
// canvas, and Chromium's DevTools protocol doesn't report cursor changes, so the page is asked.
// One lookup at a time per page, for the newest position, after the input is replayed (never in
// its way); only a change is sent
const POINTER_EVENTS = new Set(['mousemove', 'mousedown', 'mouseup', 'wheel']);
/** How long one frame may take to say its cursor */
const CURSOR_TIMEOUT_MS = 1000;
/** Iframes descended into at most */
const CURSOR_FRAME_DEPTH = 8;
/** page id -> { running, next: {x, y} | null, cursor: the last one sent } */
const cursorLookups = new Map();

function noteCursor(pageId, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  let lookup = cursorLookups.get(pageId);
  if (!lookup) {
    lookup = { running: false, next: null, cursor: 'default' };
    cursorLookups.set(pageId, lookup);
  }
  lookup.next = { x, y };
  if (!lookup.running) void lookUpCursor(pageId, lookup);
}

async function lookUpCursor(pageId, lookup) {
  lookup.running = true;
  while (lookup.next) {
    const { x, y } = lookup.next;
    lookup.next = null;
    const page = pages.get(pageId)?.page;
    if (!page) break;
    const cursor = await cursorAt(page, x, y).catch(() => null);
    if (cursor && cursor !== lookup.cursor && pages.has(pageId)) {
      lookup.cursor = cursor;
      send({ type: 'cursor', pageId, viewers: [...(casts.get(pageId)?.viewers.keys() ?? [])], cursor });
    }
  }
  lookup.running = false;
}

/**
 * The CSS cursor at a point of a frame's viewport, as the browser would show it: the computed
 * `cursor` (links get `pointer` from the browser's own stylesheet), an image cursor's keyword
 * fallback (no image reaches the app), and for `auto` the text cursor over text and editable
 * fields, the arrow elsewhere. An iframe at the point answers with the point in its own viewport
 */
function cursorInFrame({ x, y }) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { cursor: 'default' };
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      iframe: true,
      x: x - rect.left - el.clientLeft - (parseFloat(style.paddingLeft) || 0),
      y: y - rect.top - el.clientTop - (parseFloat(style.paddingTop) || 0),
    };
  }
  const keywords = getComputedStyle(el).cursor.split(',').map((part) => part.trim()).filter((part) => part && !part.startsWith('url('));
  const cursor = keywords[keywords.length - 1] || 'auto';
  if (cursor !== 'auto') return { cursor };
  const textInput = !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'color', 'file', 'range', 'hidden'].includes(el.type);
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && textInput)) return { cursor: 'text' };
  // Over a character of text (the caret position alone also lands beside text and in blank space)
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    node = position && position.offsetNode;
    offset = position ? position.offset : 0;
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    node = range && range.startContainer;
    offset = range ? range.startOffset : 0;
  }
  if (node && node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
    const range = document.createRange();
    for (const start of [offset, offset - 1]) {
      if (start < 0 || start >= node.textContent.length) continue;
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      for (const box of range.getClientRects()) {
        if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return { cursor: 'text' };
      }
    }
  }
  return { cursor: 'default' };
}

async function cursorAt(page, x, y) {
  let frame = page.mainFrame();
  let point = { x, y };
  for (let depth = 0; frame && depth < CURSOR_FRAME_DEPTH; depth++) {
    const result = await bounded(frame.evaluate(cursorInFrame, point).catch(() => null), CURSOR_TIMEOUT_MS, null);
    if (!result) return null;
    if (!result.iframe) return result.cursor;
    // The child frame whose element is at the point, same-origin or not
    const target = await bounded(
      frame.evaluateHandle((p) => document.elementFromPoint(p.x, p.y), point).catch(() => null),
      CURSOR_TIMEOUT_MS,
      null
    );
    let next = null;
    for (const child of frame.childFrames()) {
      const element = await child.frameElement().catch(() => null);
      if (!element) continue;
      const same = target ? await element.evaluate((a, b) => a === b, target).catch(() => false) : false;
      await element.dispose().catch(() => undefined);
      if (same) {
        next = child;
        break;
      }
    }
    await target?.dispose().catch(() => undefined);
    if (!next) return 'default';
    frame = next;
    point = { x: result.x, y: result.y };
  }
  return 'default';
}

async function input(pageId, event) {
  const entry = pages.get(pageId);
  const page = entry?.page;
  // A Firefox extension page takes the mouse only: its keys (and a wheel step) never return
  if (!page || (entry.mouseOnly && !['mousemove', 'mousedown', 'mouseup'].includes(event.kind))) {
    if (event.kind === 'copy') send({ type: 'copied', id: event.id, text: '' });
    return;
  }
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
    case 'copy':
      // Asked by the main process (copy and cut shortcuts): answered in turn with the keys, so a cut
      // that follows can't remove the text first
      send({ type: 'copied', id: event.id, text: await selectedText(page).catch(() => '') });
      break;
  }
}

// =============================================================================
// Extension actions (Chromium): what a click on an extension's toolbar button does
// =============================================================================

/** How long an extension's popup may take to show after its action ran */
const POPUP_WAIT_MS = 1500;
/** Popups are at most this big (the browser's own limit), in CSS pixels */
const POPUP_MAX = { width: 800, height: 600 };
/** A popup's size under Juggler, where its content can't be measured (see firefoxExtensionAction) */
const FIREFOX_POPUP = { width: 380, height: 560 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A session's browser-level CDP session (Chromium only), made once */
async function browserCdp(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('The browser is gone');
  session.cdp ??= await session.browser.newBrowserCDPSession();
  return session.cdp;
}

/** One popup at a time, as in the browser */
function closePopups(sessionId) {
  for (const [id, other] of pages) {
    if (other.popup && other.sessionId === sessionId) closePage(id).catch(() => undefined);
  }
}

/** Open a page in a new tab of the page's browser, for the drawer (not navigated yet) */
async function openTab(entry) {
  const page = await entry.page.context().newPage();
  const id = pageIds.get(page) ?? addPage(page, entry.sessionId);
  return { page, id, added: pages.get(id) };
}

/**
 * Firefox: its popup can't open as one (a popup is a panel of the browser's window, which a headless
 * browser lacks and neither Juggler nor WebDriver BiDi can open), so the popup's page opens in a new
 * tab the drawer shows as the popup. An extension without a popup opens its homepage in a new tab
 * instead.
 *
 * WebDriver BiDi (the user's own Firefox) opens extension pages thanks to the system access chat
 * browsers get (chat-browsers.ts). The popup loads in front, hidden from the drawer, where it is
 * measured (its size is its content's, as the browser sizes a popup); then the tab it opened for
 * goes back in front and the popup loads again behind it, as under the browser's own popup: the
 * extension acts on the active tab, which its popup asks for as it loads. Juggler (Playwright's
 * Firefox) ignores extension pages, so the tab's address, title, size and keys stay out of reach
 * there: its tab stays in front at a fixed size, driven by the mouse only (its frames and clicks go
 * through the browser window)
 */
async function firefoxExtensionAction(entry, pageId, extensionId, name, target) {
  const popupUrl = typeof target.popupUrl === 'string' && target.popupUrl.startsWith('moz-extension://') ? target.popupUrl : '';
  const homepageUrl = typeof target.homepageUrl === 'string' && /^https?:\/\//i.test(target.homepageUrl) ? target.homepageUrl : '';
  if (!popupUrl && !homepageUrl) return undefined;
  closePopups(entry.sessionId);
  const { page, id, added } = await openTab(entry);
  if (!popupUrl) {
    page.goto(homepageUrl, { timeout: 30000 }).catch(log);
    return undefined;
  }
  if (!added) return undefined;
  added.popup = { extensionId, openerId: pageId, ...FIREFOX_POPUP };
  added.title = String(name || '');
  if (!sessions.get(entry.sessionId)?.bidi) {
    added.mouseOnly = true;
    pushPages();
    // Never reported as loaded (see above): its frames show it once it has
    page.goto(popupUrl, { waitUntil: 'commit', timeout: 5000 }).catch(() => undefined);
    return id;
  }
  added.hidden = true;
  added.privileged = true;
  // WebDriver BiDi can't set an extension page's viewport
  added.keepsViewport = true;
  try {
    // No load event comes for an extension page (WebDriver BiDi reports none of a privileged page).
    // The first extension page a browser loads may never give Playwright its script context:
    // loaded once more then
    let measured = false;
    for (let attempt = 0; attempt < 2 && !measured && pages.has(id); attempt++) {
      await bounded(page.goto(popupUrl, { waitUntil: 'commit', timeout: COMMAND_TIMEOUT_MS }).catch(() => undefined), COMMAND_TIMEOUT_MS);
      measured = await settlePopupSize(id);
    }
    await bounded(entry.page.bringToFront().catch(() => undefined), COMMAND_TIMEOUT_MS);
    if (measured) {
      await bounded(page.evaluate(() => void setTimeout(() => location.reload())).catch(() => undefined), COMMAND_TIMEOUT_MS);
    }
  } finally {
    added.hidden = false;
    pushPages();
  }
  return id;
}

/**
 * How long a popup's page may take to answer a first measuring (a browser just started is slow to
 * give a new page its script context), then to settle on its size, measured every step meanwhile
 */
const POPUP_FIRST_MEASURE_MS = 3000;
const POPUP_SETTLE_MS = 2000;
const POPUP_SETTLE_STEP_MS = 200;
/** How long one measuring may take */
const POPUP_MEASURE_TIMEOUT_MS = 1000;

/** Measure a popup until its size holds (its content may render a moment after it loads) */
async function settlePopupSize(pageId) {
  let last = null;
  let until = Date.now() + POPUP_FIRST_MEASURE_MS;
  while (Date.now() < until && pages.get(pageId)?.popup) {
    const size = await measurePopup(pageId);
    if (size && last && size.width === last.width && size.height === last.height) break;
    if (size && !last) until = Date.now() + POPUP_SETTLE_MS;
    if (size) last = size;
    await sleep(POPUP_SETTLE_STEP_MS);
  }
  return last !== null;
}

/** A popup's page sized to its content: the size, if it answered */
async function measurePopup(pageId) {
  const entry = pages.get(pageId);
  if (!entry?.popup) return null;
  const size = await bounded(entry.page.evaluate(popupContentSize, POPUP_MAX).catch(() => null), POPUP_MEASURE_TIMEOUT_MS, null);
  if (!size || !(size.width > 0 && size.height > 0)) return null;
  let { width, height } = size;
  // A popup's tab keeps its viewport (see keepsViewport), streamed whole: the drawer shows the corner
  // its content takes
  if (entry.keepsViewport) {
    const viewport = size.viewport;
    if (!entry.viewport || entry.viewport.width !== viewport.width || entry.viewport.height !== viewport.height) {
      entry.viewport = viewport;
      if (casts.get(pageId)?.viewers.size) enqueue(() => startCast(pageId));
    }
    width = Math.min(width, viewport.width);
    height = Math.min(height, viewport.height);
  }
  if (width !== entry.popup.width || height !== entry.popup.height) {
    entry.popup = { ...entry.popup, width, height };
    pushPages();
  }
  return { width, height };
}

/**
 * The size a browser gives an extension's popup, in the page: its document's preferred width (the
 * widest its content lays out) and its height at that width, at most `max`
 */
function popupContentSize(max) {
  const root = document.documentElement;
  const style = root.getAttribute('style');
  try {
    root.style.setProperty('width', 'max-content', 'important');
    const width = Math.min(Math.ceil(root.getBoundingClientRect().width), max.width);
    root.style.setProperty('width', `${width}px`, 'important');
    root.style.setProperty('height', 'max-content', 'important');
    const height = Math.min(Math.ceil(Math.max(root.getBoundingClientRect().height, root.scrollHeight)), max.height);
    return { width, height, viewport: { width: innerWidth, height: innerHeight } };
  } finally {
    if (style === null) root.removeAttribute('style');
    else root.setAttribute('style', style);
  }
}

/**
 * Chromium: a headless browser's popup keeps the size its view first had (it never grows to its
 * content, and takes no other: no window, no metrics override), so its page opens in a tab behind
 * the page's instead, shown once measured, as the corner of the tab its content takes.
 * The page's tab stays the active one, so the extension acts on it (its popup asks for the active
 * tab as it loads), and a background tab still renders in a headless browser
 */
async function chromiumPopupTab(entry, pageId, extensionId, name, popupUrl) {
  const { page, id, added } = await openTab(entry);
  if (!added) return undefined;
  added.popup = { extensionId, openerId: pageId, ...POPUP_MAX };
  added.title = String(name || '');
  added.hidden = true;
  // Its viewport is never set: a headless Chromium's tabs share their window, so one tab's resized
  // the frames of the page it opened for
  added.keepsViewport = true;
  try {
    await bounded(entry.page.bringToFront().catch(() => undefined), COMMAND_TIMEOUT_MS);
    await page.goto(popupUrl, { timeout: COMMAND_TIMEOUT_MS }).catch(() => undefined);
    await settlePopupSize(id);
  } finally {
    added.hidden = false;
    pushPages();
  }
  return id;
}

/**
 * Click an extension's toolbar button for a page (Chromium's Extensions.triggerAction, as the
 * browser's own button does: its popup opens for that tab, or the extension's click handler runs).
 * The popup the browser opens gives its address (the one the extension set for that tab) and closes:
 * its page is shown as the popup (chromiumPopupTab), over the page it opened for. Answers with the
 * popup's page id, if one opened
 */
async function extensionAction(requestId, pageId, extensionId, name, target) {
  try {
    const entry = pages.get(pageId);
    if (!entry || entry.popup) throw new Error('The page is gone');
    if (sessions.get(entry.sessionId)?.browser.browserType().name() === 'firefox') {
      const popupId = await firefoxExtensionAction(entry, pageId, extensionId, name, target || {});
      send({ type: 'extensionActionDone', id: requestId, ...(popupId ? { popupId } : {}) });
      return;
    }
    const cdp = await browserCdp(entry.sessionId);
    // The page's tab (the target an action runs for), told by its address (Chrome names no tab of a page)
    const { targetInfos: tabs } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tabId = tabs.find((target) => target.url === entry.page.url())?.targetId;
    if (!tabId) throw new Error('The tab was not found');
    const { targetInfos } = await cdp.send('Target.getTargets');
    closePopups(entry.sessionId);
    const prefix = `chrome-extension://${extensionId}/`;
    const isPopup = (target) => target.type === 'page' && target.url.startsWith(prefix) && !target.attached;
    const before = new Set(targetInfos.filter(isPopup).map((target) => target.targetId));
    await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: tabId });
    // A popup shows within a moment; an action without one has run (its tabs show as tabs)
    const until = Date.now() + POPUP_WAIT_MS;
    while (Date.now() < until) {
      await sleep(100);
      const popup = (await cdp.send('Target.getTargets')).targetInfos.find((target) => isPopup(target) && !before.has(target.targetId));
      if (!popup) continue;
      await cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => undefined);
      const popupId = await chromiumPopupTab(entry, pageId, extensionId, name, popup.url);
      send({ type: 'extensionActionDone', id: requestId, ...(popupId ? { popupId } : {}) });
      return;
    }
    send({ type: 'extensionActionDone', id: requestId });
  } catch (error) {
    send({ type: 'extensionActionDone', id: requestId, error: String(error && error.message ? error.message : error) });
  }
}

/**
 * Stop the page's loading, as a browser's stop button does: Chromium's own Page.stopLoading,
 * `window.stop()` in other browsers
 */
async function stopLoading(entry) {
  const { page } = entry;
  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Page.stopLoading');
    } finally {
      cdp.detach().catch(() => undefined);
    }
  } catch {
    await bounded(page.evaluate(() => window.stop()), 3000, undefined).catch(() => undefined);
  }
  entry.setLoading?.(false);
}

async function navigate(pageId, action, url) {
  const entry = pages.get(pageId);
  const page = entry?.page;
  if (!page) return;
  if (action === 'stop') return stopLoading(entry);
  const options = { timeout: 30000 };
  if (action === 'back') await page.goBack(options);
  else if (action === 'forward') await page.goForward(options);
  else if (action === 'reload') await page.reload(options);
  else if (action === 'goto' && url) await page.goto(url, options);
}

/** Whether a bound browser's socket (or ws:// endpoint) answers; a slow answer counts as live (registry.ts canConnect) */
function canConnect(endpoint) {
  return new Promise((resolve) => {
    let socket;
    try {
      if (/^wss?:\/\//.test(endpoint)) {
        const url = new URL(endpoint);
        socket = net.createConnection(Number(url.port) || (url.protocol === 'wss:' ? 443 : 80), url.hostname);
      } else {
        socket = net.createConnection(endpoint);
      }
    } catch {
      resolve(false);
      return;
    }
    const done = (result) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(true), 1000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Which of the endpoints answer (WSL mode: the main process can't reach the sockets) */
async function probe(id, endpoints) {
  const list = Array.isArray(endpoints) ? endpoints.filter((e) => typeof e === 'string') : [];
  const answers = await Promise.all(list.map((endpoint) => canConnect(endpoint)));
  send({ type: 'probed', id, live: list.filter((_, index) => answers[index]) });
}

function onMessage(message) {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'sessions':
      enqueue(() => setSessions(Array.isArray(message.sessions) ? message.sessions : []));
      break;
    case 'view':
      enqueue(() => view(message.viewerId, message.pageId, Math.round(message.width), Math.round(message.height), Number(message.scale)));
      break;
    case 'input':
      queueInput(message.pageId, message.event);
      break;
    case 'copy':
      // The page's selected text, after the input before it
      if (pages.has(message.pageId)) queueInput(message.pageId, { kind: 'copy', id: message.id });
      else send({ type: 'copied', id: message.id, text: '' });
      break;
    case 'navigate':
      // Not queued: a slow page must not hold up the other commands
      navigate(message.pageId, message.action, message.url).catch(log);
      break;
    case 'frameAck':
      frameDrawn(message.pageId);
      break;
    case 'extensionAction':
      // Not queued: it waits a moment for the popup
      void extensionAction(message.id, message.pageId, String(message.extensionId || ''), message.name, message.target);
      break;
    case 'closePage':
      closePage(message.pageId).catch(log);
      break;
    case 'newPage':
      enqueue(() => newPage(message.sessionId));
      break;
    case 'probe':
      // Not queued: answered while a slow connect runs
      probe(message.id, message.endpoints).catch(log);
      break;
    case 'colorScheme':
      colorScheme = message.scheme === 'dark' ? 'dark' : 'light';
      for (const entry of pages.values()) applyColorScheme(entry.page);
      break;
  }
}

// Messages from the main process (bridge-framing.ts's codec)
let received = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  received = received.length ? Buffer.concat([received, chunk]) : chunk;
  for (;;) {
    let start = 0;
    while (start < received.length && !(received[start] === 0x57 && (start + 1 >= received.length || received[start + 1] === 0x42))) start++;
    if (start > 0) received = received.subarray(start);
    if (received.length < 10) return;
    const headerLength = received.readUInt32BE(2);
    const bytesLength = received.readUInt32BE(6);
    if (headerLength > 64 * 1024 * 1024 || bytesLength > 64 * 1024 * 1024) {
      received = received.subarray(1);
      continue;
    }
    const total = 10 + headerLength + bytesLength;
    if (received.length < total) return;
    let header = null;
    try {
      header = JSON.parse(received.subarray(10, 10 + headerLength).toString('utf-8'));
    } catch {
      // Skipped
    }
    if (header && typeof header.$bytes === 'string') header[header.$bytes] = new Uint8Array(received.subarray(10 + headerLength, total));
    if (header) delete header.$bytes;
    received = received.subarray(total);
    try {
      onMessage(header);
    } catch (error) {
      log(error);
    }
  }
});

// Gone with the main process (its end of stdin closed): disconnect (the browsers keep running)
let exiting = false;
function exitBridge() {
  if (exiting) return;
  exiting = true;
  Promise.all([...sessions.values()].map((entry) => entry.browser.close().catch(() => undefined)))
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.stdin.on('end', exitBridge);
process.stdin.on('error', exitBridge);
