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
// theme as its `prefers-color-scheme`, and replays the viewer's mouse, wheel and keys on it.
// Plain Node, no packages of its own.
'use strict';

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
      // Not back to the blank page a tab starts on (the browser's own Back is disabled there too)
      canGoBack: entry.history.urls.slice(0, Math.max(0, entry.history.index)).some((url, index) => !(index === 0 && url === 'about:blank')),
      canGoForward: entry.history.index < entry.history.urls.length - 1,
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
  const entry = { page, sessionId, loading: false, loadingTimer: null, history: { urls: [], index: -1 }, ...(popup ? { popup } : {}) };
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
    if (frame === page.mainFrame()) void noteNavigation(entry).catch(() => undefined);
  });
  // Not every history step reports a navigation (WebDriver BiDi): its load counts too
  page.on('load', () => void noteNavigation(entry).catch(() => undefined));
  void noteNavigation(entry).catch(() => undefined);
  return id;
}

/**
 * Follow a tab's history as it navigates (no protocol tells where a tab is in its history): the
 * address it shows now against the ones before and after it, with the page's `history.length`
 * telling a new entry from a replaced one. Back and Forward then say whether there is anywhere
 * to go, whoever navigates (the user, the agent, the page itself)
 */
async function noteNavigation(entry) {
  const url = entry.page.url();
  // Asked so it can't throw here (a page that is going): unknown then
  const length = await bounded(Promise.resolve().then(() => entry.page.evaluate(() => history.length)).catch(() => null), HISTORY_LENGTH_TIMEOUT_MS, null);
  const history = entry.history;
  const known = history.urls.length;
  const same = length === null || length === known;
  if (history.index >= 0 && history.urls[history.index] === url && same) {
    // Reloaded, or the same address again
  } else if (history.index > 0 && history.urls[history.index - 1] === url && same) {
    history.index--;
  } else if (history.index < known - 1 && history.urls[history.index + 1] === url && same) {
    history.index++;
  } else if (same && history.index === known - 1 && history.index >= 0) {
    // The same number of entries, at the last one: it was replaced (a redirect, replaceState)
    history.urls[history.index] = url;
  } else {
    // A new entry: the ones after it (gone back to earlier) are dropped
    history.urls = [...history.urls.slice(0, history.index + 1), url];
    history.index = history.urls.length - 1;
  }
  // Entries from before the drawer knew the tab (it was attached later): counted, unknown but for
  // the first, the blank page a chat browser's tab starts on
  if (length !== null && length > history.urls.length) {
    const missing = length - history.urls.length;
    history.index += missing;
    history.urls = [...Array(missing).fill(null), ...history.urls];
    if (history.urls[0] === null) history.urls[0] = 'about:blank';
  }
  pushPages();
}

/** How long a page may take to say its history's length */
const HISTORY_LENGTH_TIMEOUT_MS = 1000;

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
  if (!entry.extensionPage) return entry.page.close();
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
  if (entry.tabCapture) {
    startTabCast(pageId, entry, cast);
    return;
  }
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
/** How long after the drawer set a page's viewport frames of the old size may still come (a resize, not a hidden tab) */
const VIEWPORT_CHANGE_GRACE_MS = 1500;
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
  // The drawer just resized it: frames of the old size are on their way, shown as they come
  if (entry.viewportSetAt && now - entry.viewportSetAt < VIEWPORT_CHANGE_GRACE_MS) return false;
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
  if (!cast || cast.viewers.size === 0 || !cast.size || cast.size.tab || cast.framed) return;
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
  if (entry && cast.size && !cast.size.tab) await bounded(entry.page.screencast.stop().catch(() => undefined), COMMAND_TIMEOUT_MS);
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
      // Frames of the old size still on their way aren't the hidden tab's (staleChromiumFrame)
      entry.viewportSetAt = Date.now();
      const resized = entry.page.setViewportSize({ width, height }).catch((error) => log(error));
      // A resize that stalls: another tab came to the front since (Claude opened or picked one).
      // Never a popup's: the page it opened for stays in front
      if (!switched && !entry.popup && !(await bounded(resized.then(() => true), RESIZE_STALL_MS, false))) {
        entry.page.bringToFront().catch(() => undefined);
      }
      await bounded(resized, COMMAND_TIMEOUT_MS);
      entry.viewportSetAt = Date.now();
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
    // Not over a page that never answers: Juggler ignores an extension page's documents, and WebDriver
    // BiDi a privileged one's once it loaded behind its tab (each lookup would stay pending)
    const looked = pages.get(pageId);
    if (POINTER_EVENTS.has(event.kind) && !looked?.mouseOnly && !looked?.privileged) noteCursor(pageId, event.x, event.y);
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
  let el = document.elementFromPoint(x, y);
  // Into open shadow roots: the element under the point inside a web component (a link, a button)
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
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
    // The child frame whose element is at the point, same-origin or not (looked for in open
    // shadow roots too, as cursorInFrame does)
    const target = await bounded(
      frame.evaluateHandle((p) => {
        let el = document.elementFromPoint(p.x, p.y);
        while (el && el.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint(p.x, p.y);
          if (!inner || inner === el) break;
          el = inner;
        }
        return el;
      }, point).catch(() => null),
      CURSOR_TIMEOUT_MS,
      null
    );
    // Its frame in one call; else each child frame's element is compared with it
    let next = target ? await bounded(target.contentFrame().catch(() => null), CURSOR_TIMEOUT_MS, null) : null;
    for (const child of next ? [] : frame.childFrames()) {
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
  // A page the browser won't drive (see firefoxExtensionAction): its input as DOM events in it
  if (entry.domInput && event.kind !== 'copy') {
    entry.lastInputAt = Date.now();
    await page.evaluate(domInput, { ...event, button });
    return;
  }
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

/**
 * The drawer's input as DOM events, in the page (a Firefox extension's popup, whose input the browser
 * won't take over WebDriver BiDi): pointer and mouse events where the mouse is, with a click when a
 * button goes up where it went down; keys on the focused element, typing and editing keys done as
 * the browser would (through its editing commands, so the page sees its usual input events); the
 * wheel scrolls what is under the mouse
 */
function domInput(event) {
  const state = (window.__workbenchInput ??= { buttons: 0, down: null, hover: null, modifiers: new Set() });
  const BUTTON = { left: 0, middle: 1, right: 2 };
  const MASK = { left: 1, middle: 4, right: 2 };
  /**
   * What is under the mouse, as the browser finds it: into open shadow trees and same-origin frames
   * (elementFromPoint stops at their host), with the point in that element's own document
   */
  const pick = () => {
    let doc = document;
    let px = event.x ?? 0;
    let py = event.y ?? 0;
    let element = doc.elementFromPoint(px, py);
    for (let depth = 0; element && depth < 32; depth++) {
      const inner = element.shadowRoot?.elementFromPoint(px, py);
      if (inner && inner !== element) {
        element = inner;
        continue;
      }
      if (element.localName === 'iframe' || element.localName === 'frame') {
        let frameDoc = null;
        try {
          frameDoc = element.contentDocument;
        } catch {
          frameDoc = null;
        }
        if (frameDoc?.documentElement) {
          const box = element.getBoundingClientRect();
          px -= box.left + element.clientLeft;
          py -= box.top + element.clientTop;
          doc = frameDoc;
          element = doc.elementFromPoint(px, py) || doc.body || doc.documentElement;
          continue;
        }
      }
      break;
    }
    return { target: element || document.body || document.documentElement, x: px, y: py, doc };
  };
  /** The focused element, into shadow trees and same-origin frames */
  const focused = () => {
    let element = document.activeElement || document.body;
    for (let depth = 0; element && depth < 32; depth++) {
      if (element.shadowRoot?.activeElement) {
        element = element.shadowRoot.activeElement;
        continue;
      }
      if (element.localName === 'iframe' || element.localName === 'frame') {
        let frameDoc = null;
        try {
          frameDoc = element.contentDocument;
        } catch {
          frameDoc = null;
        }
        if (frameDoc?.activeElement) {
          element = frameDoc.activeElement;
          continue;
        }
      }
      break;
    }
    return element || document.body;
  };
  const mods = () => ({
    ctrlKey: state.modifiers.has('Control'),
    shiftKey: state.modifiers.has('Shift'),
    altKey: state.modifiers.has('Alt'),
    metaKey: state.modifiers.has('Meta'),
  });
  const mouseInit = (point, extra) => ({
    bubbles: true, cancelable: true, composed: true, view: point.doc.defaultView, clientX: point.x, clientY: point.y,
    screenX: event.x ?? 0, screenY: event.y ?? 0, button: BUTTON[event.button] ?? 0, buttons: state.buttons, ...mods(), ...extra,
  });
  const pointer = (type, target, point) => {
    const View = point.doc.defaultView;
    return target.dispatchEvent(new View.PointerEvent(type, { ...mouseInit(point, {}), pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  };
  const mouse = (type, target, point, extra = {}) => target.dispatchEvent(new point.doc.defaultView.MouseEvent(type, mouseInit(point, extra)));
  const focusable = (element) => {
    for (let node = element; node && node.nodeType !== Node.DOCUMENT_NODE; node = node.parentElement || node.getRootNode()?.host) {
      if (node.tabIndex >= 0 || node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(node.tagName)) return node;
    }
    return null;
  };
  const hoverTo = (target, point) => {
    if (state.hover === target) return;
    const previous = state.hover;
    if (previous?.isConnected) {
      pointer('pointerout', previous, point);
      mouse('mouseout', previous, point, { relatedTarget: target });
    }
    pointer('pointerover', target, point);
    mouse('mouseover', target, point, { relatedTarget: previous });
    state.hover = target;
  };
  const editable = (element) => element && (element.isContentEditable || (element.tagName === 'TEXTAREA') || (element.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(element.type)));
  /** The caret moved in a field (fields without a caret API, such as email and number, keep theirs) */
  const setCaret = (field, start, end, direction) => {
    try {
      field.setSelectionRange(start, end, direction);
      return true;
    } catch {
      return false;
    }
  };
  /** An editing command, in the document the element is in */
  const edit = (element, command, value) => (element?.ownerDocument || document).execCommand(command, false, value);
  switch (event.kind) {
    case 'mousemove': {
      const point = pick();
      hoverTo(point.target, point);
      pointer('pointermove', point.target, point);
      mouse('mousemove', point.target, point);
      break;
    }
    case 'mousedown': {
      const point = pick();
      const { target } = point;
      hoverTo(target, point);
      state.buttons |= MASK[event.button] ?? 1;
      pointer('pointerdown', target, point);
      state.down = target;
      const proceed = mouse('mousedown', target, point, { detail: event.clickCount || 1 });
      if (proceed) {
        const next = focusable(target);
        if (next) next.focus();
        else focused()?.blur?.();
        // The caret where the click is, as the browser puts it
        const caret = event.button === 'left' && editable(next) ? point.doc.caretPositionFromPoint?.(point.x, point.y) : null;
        if (caret) {
          if (next.setSelectionRange && (caret.offsetNode === next || next.contains(caret.offsetNode))) {
            setCaret(next, caret.offset, caret.offset);
          } else if (next.isContentEditable) {
            point.doc.getSelection()?.collapse(caret.offsetNode, caret.offset);
          }
        }
      }
      if (event.button === 'right') mouse('contextmenu', target, point);
      break;
    }
    case 'mouseup': {
      const point = pick();
      const { target } = point;
      state.buttons &= ~(MASK[event.button] ?? 1);
      pointer('pointerup', target, point);
      mouse('mouseup', target, point, { detail: event.clickCount || 1 });
      const down = state.down;
      state.down = null;
      // A click goes to what both the press and the release were over (as the browser picks it,
      // across shadow boundaries)
      let common = down;
      const within = (outer, inner) => {
        for (let node = inner; node; node = node.parentNode || node.host) if (node === outer) return true;
        return false;
      };
      while (common && !within(common, target)) common = common.parentNode?.nodeType === Node.ELEMENT_NODE ? common.parentNode : common.parentNode?.host ?? null;
      if (common && event.button !== 'right') {
        mouse(event.button === 'middle' ? 'auxclick' : 'click', common, point, { detail: event.clickCount || 1 });
        if (event.button === 'left' && (event.clickCount || 1) === 2) mouse('dblclick', common, point, { detail: 2 });
      }
      break;
    }
    case 'wheel': {
      const point = pick();
      const { target } = point;
      const View = point.doc.defaultView;
      const proceed = target.dispatchEvent(new View.WheelEvent('wheel', { ...mouseInit(point, {}), deltaX: event.deltaX || 0, deltaY: event.deltaY || 0, deltaMode: 0 }));
      if (!proceed) break;
      // Scrolled: the nearest box under the mouse that can scroll that way, else its document
      for (let node = target; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement || node.getRootNode()?.host) {
        const style = View.getComputedStyle(node);
        const canY = (event.deltaY || 0) !== 0 && /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
        const canX = (event.deltaX || 0) !== 0 && /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
        if (canY || canX) {
          node.scrollBy(event.deltaX || 0, event.deltaY || 0);
          return;
        }
      }
      View.scrollBy(event.deltaX || 0, event.deltaY || 0);
      break;
    }
    case 'keydown':
    case 'keyup': {
      const key = String(event.key || '');
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
        if (event.kind === 'keydown') state.modifiers.add(key);
        else state.modifiers.delete(key);
      }
      const target = focused();
      const View = target.ownerDocument?.defaultView || window;
      const init = { key, bubbles: true, cancelable: true, composed: true, view: View, ...mods() };
      const proceed = target.dispatchEvent(new View.KeyboardEvent(event.kind, init));
      if (event.kind === 'keyup' || !proceed) break;
      const command = state.modifiers.has('Control') || state.modifiers.has('Meta');
      const shift = state.modifiers.has('Shift');
      if (key === ' ' && !command && !editable(target) && ['BUTTON', 'INPUT', 'SUMMARY'].includes(target.tagName)) {
        // Space presses a button, toggles a checkbox or radio
        target.click();
      } else if ([...key].length === 1 && !command) {
        target.dispatchEvent(new View.KeyboardEvent('keypress', { ...init, charCode: key.codePointAt(0) }));
        if (editable(target)) edit(target, 'insertText', key);
      } else if (command && key.toLowerCase() === 'a') {
        if (editable(target) && target.select) target.select();
        else edit(target, 'selectAll');
      } else if (command && key.toLowerCase() === 'z') {
        edit(target, shift ? 'redo' : 'undo');
      } else if (command && key.toLowerCase() === 'y') {
        edit(target, 'redo');
      } else if (command && key.toLowerCase() === 'x' && editable(target)) {
        // The selection was copied with the copy shortcut's request: it goes from the field
        edit(target, 'delete');
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key) && editable(target) && target.setSelectionRange && target.selectionStart !== null) {
        // The caret moves (Shift extends the selection), as in a text field
        const length = target.value.length;
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? 0;
        const backward = target.selectionDirection === 'backward';
        const focus = backward ? start : end;
        const anchor = backward ? end : start;
        const moved = key === 'Home' ? 0 : key === 'End' ? length
          : key === 'ArrowLeft' ? (start !== end && !shift ? start : Math.max(0, focus - 1))
          : (start !== end && !shift ? end : Math.min(length, focus + 1));
        if (shift) setCaret(target, Math.min(anchor, moved), Math.max(anchor, moved), moved < anchor ? 'backward' : 'forward');
        else setCaret(target, moved, moved);
      } else if (key.startsWith('Arrow') || key === 'Home' || key === 'End') {
        // Elsewhere (rich text): the selection moves as the browser moves it
        const selection = target.ownerDocument?.getSelection();
        const direction = { ArrowLeft: 'backward', ArrowUp: 'backward', Home: 'backward', ArrowRight: 'forward', ArrowDown: 'forward', End: 'forward' }[key];
        const granularity = key === 'ArrowUp' || key === 'ArrowDown' ? 'line' : key === 'Home' || key === 'End' ? 'lineboundary' : 'character';
        if (selection?.rangeCount && target.isContentEditable) selection.modify(shift ? 'extend' : 'move', direction, granularity);
      } else if (key === 'Backspace' && editable(target)) {
        edit(target, 'delete');
      } else if (key === 'Delete' && editable(target)) {
        edit(target, 'forwardDelete');
      } else if (key === 'Enter') {
        if (target.tagName === 'TEXTAREA' || target.isContentEditable) edit(target, 'insertLineBreak');
        else if (target.tagName === 'INPUT' && target.form) target.form.requestSubmit();
        else if (['BUTTON', 'A', 'SUMMARY'].includes(target.tagName)) target.click();
      } else if (key === 'Tab') {
        // Focus moves to the next (or previous) element that takes it, in the document's order
        const doc = target.ownerDocument || document;
        const all = [...doc.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable]')]
          .filter((element) => element.tabIndex >= 0 && !element.disabled && element.getClientRects().length > 0);
        if (all.length > 0) {
          const index = all.indexOf(target);
          all[(index + (shift ? -1 : 1) + all.length) % all.length].focus();
        }
      }
      break;
    }
    case 'text': {
      const target = focused();
      if (editable(target)) edit(target, 'insertText', String(event.text || ''));
      break;
    }
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

/**
 * Whether the browser won't capture the page (newer Firefox, for an extension's page over WebDriver
 * BiDi: "browsing contexts in privileged scope"). Any failure counts: the page's own capture (or its
 * drawing) shows it either way, where a screencast the browser refuses would show nothing
 */
async function captureRefused(page) {
  try {
    await page.screenshot({ timeout: COMMAND_TIMEOUT_MS });
    return false;
  } catch {
    return true;
  }
}

/** How long one capture of a popup's tab may take, and how long the next waits after a frame was drawn */
const TAB_CAPTURE_TIMEOUT_MS = 2000;
const TAB_CAPTURE_STEP_MS = 40;
/** The longest wait between captures while the popup shows the same (a change or input brings it back to the shortest) */
const TAB_CAPTURE_IDLE_STEP_MS = 400;
/** Captures failing in a row before the popup is drawn from its document instead */
const TAB_CAPTURE_FAILURES = 3;

/**
 * Capture a popup's own tab, in its page, with its extension's `tabs.captureTab` (the browser draws
 * it as it shows it). Firefox captures an extension's page clearly only for that extension (for
 * another it gives a grey pixel), and only one holding `<all_urls>` has captureTab
 */
async function captureOwnTab({ tabId, width, height, scale }) {
  const id = tabId ?? (await browser.tabs.getCurrent()).id;
  const data = await browser.tabs.captureTab(id, { format: 'jpeg', quality: 92, rect: { x: 0, y: 0, width, height }, scale });
  return { tabId: id, data };
}

/**
 * Draw a popup's page into an image, in the page, for one whose extension can't capture it (no
 * `<all_urls>`). The browser lays it out again from what the page is now, as an SVG image (which
 * loads nothing of its own, so every resource it names is inlined):
 * - its documents' style sheets (imported ones too), with the media queries the page matches now
 *   (its color scheme, its size) resolved here, not in the image
 * - its elements as they are: form fields' state, canvases and videos as pictures, images as
 *   loaded, scrolled boxes at their scroll, SVG sprites from other files, same-origin frames drawn
 *   the same way
 * - shadow trees flattened into the image (slots filled), their elements with the styles they
 *   compute (selectors scoped to a shadow tree mean nothing in it), ::before / ::after included
 * - animations and transitions frozen where they are now (an image would start them over)
 * Only after the page changed (a mutation, input, scroll...), else at most once a second; null
 * when nothing changed
 */
async function paintSelf({ width, height, scale, quality, force }) {
  const state = (window.__workbenchPaint ??= { dirty: true, last: 0, resources: new Map(), sprites: new Map(), observed: new WeakSet() });
  const watch = (root) => {
    if (state.observed.has(root)) return;
    state.observed.add(root);
    new MutationObserver(() => {
      state.dirty = true;
    }).observe(root, { attributes: true, childList: true, subtree: true, characterData: true });
  };
  if (!state.listening) {
    state.listening = true;
    for (const type of ['input', 'change', 'scroll', 'focusin', 'focusout', 'transitionend', 'animationend', 'load']) {
      document.addEventListener(type, () => {
        state.dirty = true;
      }, true);
    }
  }
  watch(document);
  // One paint at a time: a slow one isn't started over beside itself
  if (state.painting) return null;
  // A changed size or scale (another view) paints again too; with nothing changed, only while
  // something animates (once a second)
  const key = `${width}x${height}@${scale}`;
  const animating = () => (document.getAnimations?.() ?? []).some((animation) => animation.playState === 'running');
  if (!force && !state.dirty && state.key === key && (Date.now() - state.last < 1000 || !animating())) return null;
  state.key = key;
  state.dirty = false;
  state.last = Date.now();
  state.painting = true;
  try {
    return await paintNow();
  } finally {
    state.painting = false;
  }

  async function paintNow() {

    /** A resource as a data: address */
    const inline = (url, base) => {
      let absolute;
      try {
        absolute = new URL(url, base).href;
      } catch {
        return Promise.resolve(url);
      }
      if (absolute.startsWith('data:')) return Promise.resolve(absolute);
      if (!state.resources.has(absolute)) {
        state.resources.set(absolute, (async () => {
          try {
            const blob = await (await fetch(absolute)).blob();
            return await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => resolve(absolute);
              reader.readAsDataURL(blob);
            });
          } catch {
            return absolute;
          }
        })());
      }
      return state.resources.get(absolute);
    };
    const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    const inlineUrls = async (text, base) => {
      const found = [...text.matchAll(URL_PATTERN)].filter((match) => !match[2].startsWith('data:') && !match[2].startsWith('#'));
      if (found.length === 0) return text;
      const urls = await Promise.all(found.map((match) => inline(match[2], base)));
      let index = 0;
      return text.replace(URL_PATTERN, (whole, quote, url) => (url.startsWith('data:') || url.startsWith('#') ? whole : `url("${urls[index++]}")`));
    };

    /**
     * A sheet's style rules as text, with media queries resolved as the page matches them and imported
     * sheets expanded (their addresses resolved against their own)
     */
    const rulesText = async (rules, view, base) => {
      let text = '';
      let plain = '';
      const flush = async () => {
        if (plain) text += await inlineUrls(plain, base);
        plain = '';
      };
      for (const rule of rules) {
        if (rule instanceof view.CSSImportRule) {
          await flush();
          if (rule.styleSheet && (!rule.media.mediaText || view.matchMedia(rule.media.mediaText).matches)) {
            try {
              text += await rulesText(rule.styleSheet.cssRules, view, rule.styleSheet.href || base);
            } catch {
              // Another origin's sheet: left out
            }
          }
        } else if (rule instanceof view.CSSMediaRule) {
          await flush();
          if (view.matchMedia(rule.media.mediaText).matches) text += await rulesText(rule.cssRules, view, base);
        } else {
          plain += `${rule.cssText}\n`;
        }
      }
      await flush();
      return text;
    };
    const documentCss = async (doc, view) => {
      let text = '';
      for (const sheet of [...doc.styleSheets, ...(doc.adoptedStyleSheets || [])]) {
        if (sheet.disabled || (sheet.media?.mediaText && !view.matchMedia(sheet.media.mediaText).matches)) continue;
        try {
          text += await rulesText(sheet.cssRules, view, sheet.href || doc.baseURI);
        } catch {
          // Another origin's sheet: left out
        }
      }
      return text;
    };

    /** An SVG file's element by id (sprites another file holds), parsed once */
    const spriteElement = async (href, base) => {
      let absolute;
      try {
        absolute = new URL(href, base);
      } catch {
        return null;
      }
      const file = absolute.href.split('#')[0];
      if (!state.sprites.has(file)) {
        state.sprites.set(file, fetch(file).then((response) => response.text()).then((text) => new DOMParser().parseFromString(text, 'image/svg+xml')).catch(() => null));
      }
      const sprite = await state.sprites.get(file);
      return sprite?.getElementById(decodeURIComponent(absolute.hash.slice(1))) ?? null;
    };

    /** The styles an element computes, as a style attribute (frozen: no animation or transition) */
    const computedStyleText = (style) => {
      let text = '';
      for (let index = 0; index < style.length; index++) {
        const name = style[index];
        if (name.startsWith('animation') || name.startsWith('transition')) continue;
        text += `${name}:${style.getPropertyValue(name)};`;
      }
      return `${text}animation:none;transition:none;`;
    };
    const pseudoText = (content) => {
      if (!content || content === 'none' || content === 'normal') return null;
      const strings = [...content.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\(.)/g, '$1'));
      return strings.join('');
    };

    // Copies are made in a document of their own: one in the page's would construct its custom elements again
    const scratch = document.implementation.createHTMLDocument('');
    const SVG_NS = 'http://www.w3.org/2000/svg';
    /** Copy -> the element it copies (a scrolled box moves its children by their own display) */
    const originals = new WeakMap();

    /**
     * A native checkbox or radio button drawn as one (an image draws no native controls): a box or a
     * circle in the field's colors, checked or not, at its size and place
     */
    const drawnToggle = (node, style) => {
      const width = node.offsetWidth || 13;
      const height = node.offsetHeight || 13;
      const accent = style.accentColor && style.accentColor !== 'auto' ? style.accentColor : '#0060df';
      const on = node.checked || node.indeterminate;
      const svg = scratch.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('style', `${computedStyleText(style)}appearance:none;`);
      const shape = node.type === 'radio'
        ? `<circle cx="8" cy="8" r="7" fill="${on ? accent : '#fff'}" stroke="${on ? accent : '#8f8f9d'}" stroke-width="1.5"/>${on ? '<circle cx="8" cy="8" r="3" fill="#fff"/>' : ''}`
        : `<rect x="1" y="1" width="14" height="14" rx="3" fill="${on ? accent : '#fff'}" stroke="${on ? accent : '#8f8f9d'}" stroke-width="1.5"/>${
          node.indeterminate ? '<path d="M4 8h8" stroke="#fff" stroke-width="2"/>' : on ? '<path d="M4 8.5l2.5 2.5L12 5.5" fill="none" stroke="#fff" stroke-width="2"/>' : ''}`;
      svg.innerHTML = shape;
      return svg;
    };

    const paintDocument = async (doc, docWidth, docHeight) => {
      const view = doc.defaultView;
      const root = doc.documentElement;
      // Animated elements keep the values they show now
      const animated = new Map();
      for (const animation of doc.getAnimations?.() ?? []) {
        const target = animation.effect?.target;
        if (!target || animation.effect.pseudoElement) continue;
        const names = animated.get(target) ?? new Set();
        for (const frame of animation.effect.getKeyframes?.() ?? []) {
          for (const name of Object.keys(frame)) {
            if (!['offset', 'easing', 'composite', 'computedOffset'].includes(name)) names.add(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
          }
        }
        if (animation.transitionProperty) names.add(animation.transitionProperty);
        animated.set(target, names);
      }

      const copyOf = async (node, flattened) => {
        if (node.nodeType === Node.TEXT_NODE) return scratch.createTextNode(node.data);
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        const tag = node.localName;
        // Kept empty (selectors counting siblings still count them); their sheets come from the CSSOM
        if (['script', 'noscript', 'template', 'style', 'link', 'meta', 'title', 'base'].includes(tag)) {
          const inert = scratch.importNode(node, false);
          inert.removeAttribute('href');
          inert.removeAttribute('src');
          return inert;
        }
        // Same-origin frames: drawn the same way, as a picture of them
        if (tag === 'iframe' || tag === 'frame' || tag === 'embed' || tag === 'object') {
          // A picture in its place, with its styles (rules naming its tag no longer would)
          const picture = scratch.createElement('img');
          for (const name of ['class', 'id', 'width', 'height']) {
            if (node.hasAttribute(name)) picture.setAttribute(name, node.getAttribute(name));
          }
          picture.setAttribute('style', await inlineUrls(computedStyleText(view.getComputedStyle(node)), doc.baseURI));
          let inner = null;
          try {
            inner = node.contentDocument;
          } catch {
            inner = null;
          }
          const w = node.clientWidth;
          const h = node.clientHeight;
          if (inner?.documentElement && w > 0 && h > 0) {
            try {
              picture.setAttribute('src', await paintDocument(inner, w, h));
            } catch {
              // Left blank
            }
          }
          return picture;
        }
        const copy = scratch.importNode(node, false);
        originals.set(copy, node);
        copy.removeAttribute('srcset');
        copy.removeAttribute('sizes');
        // Shadow trees and what is slotted into them carry the styles they compute
        const style = view.getComputedStyle(node);
        if (flattened || node.shadowRoot) copy.setAttribute('style', await inlineUrls(computedStyleText(style), doc.baseURI));
        else if (copy.getAttribute('style')?.includes('url(')) copy.setAttribute('style', await inlineUrls(copy.getAttribute('style'), doc.baseURI));
        const frozen = animated.get(node);
        if (frozen) {
          let text = copy.getAttribute('style') || '';
          for (const name of frozen) text += `;${name}:${style.getPropertyValue(name)} !important`;
          copy.setAttribute('style', text);
        }
        if (tag === 'input' && (node.type === 'checkbox' || node.type === 'radio') && style.appearance !== 'none') {
          return drawnToggle(node, style);
        }
        // Other native controls draw plainer in an image: they keep their size (layout stays) and a
        // select its arrow
        if (['input', 'select', 'textarea', 'button'].includes(tag) && style.appearance !== 'none') {
          copy.style.setProperty('box-sizing', 'border-box');
          copy.style.setProperty('width', `${node.offsetWidth}px`);
          copy.style.setProperty('height', `${node.offsetHeight}px`);
          if (tag === 'select' && !node.multiple && node.size <= 1) {
            // A raster arrow (an SVG image in the image draws nothing)
            const arrow = document.createElement('canvas');
            arrow.width = 20;
            arrow.height = 12;
            const pen = arrow.getContext('2d');
            pen.strokeStyle = style.color;
            pen.lineWidth = 3;
            pen.beginPath();
            pen.moveTo(2, 2);
            pen.lineTo(10, 10);
            pen.lineTo(18, 2);
            pen.stroke();
            copy.style.setProperty('background-image', `url("${arrow.toDataURL()}")`);
            copy.style.setProperty('background-size', '10px 6px');
            copy.style.setProperty('background-repeat', 'no-repeat');
            copy.style.setProperty('background-position', 'right 6px center');
            copy.style.setProperty('padding-right', '20px');
            copy.style.setProperty('appearance', 'none');
          }
        }
        if (tag === 'input') {
          if (node.type === 'checkbox' || node.type === 'radio') copy.toggleAttribute('checked', node.checked);
          else if (node.type !== 'file' && node.type !== 'password') copy.setAttribute('value', node.value);
          else if (node.type === 'password') copy.setAttribute('value', node.value.replace(/./g, '•'));
        } else if (tag === 'textarea') {
          copy.textContent = node.value;
        } else if (tag === 'option') {
          copy.toggleAttribute('selected', node.selected);
        } else if (tag === 'img' && node.currentSrc) {
          copy.setAttribute('src', await inline(node.currentSrc, doc.baseURI));
        } else if (tag === 'canvas' || tag === 'video') {
          const picture = scratch.createElement('img');
          for (const name of ['class', 'width', 'height', 'id']) {
            if (copy.hasAttribute(name)) picture.setAttribute(name, copy.getAttribute(name));
          }
          picture.setAttribute('style', computedStyleText(style));
          try {
            if (tag === 'canvas') picture.src = node.toDataURL();
            else {
              const canvas = doc.createElement('canvas');
              canvas.width = node.videoWidth;
              canvas.height = node.videoHeight;
              canvas.getContext('2d').drawImage(node, 0, 0);
              picture.src = canvas.toDataURL();
            }
          } catch {
            // One it can't read stays blank
          }
          return picture;
        } else if (tag === 'image' || tag === 'feImage') {
          const href = node.getAttribute('href') ?? node.getAttribute('xlink:href');
          if (href && !href.startsWith('#')) copy.setAttribute('href', await inline(href, doc.baseURI));
        } else if (tag === 'use') {
          // A sprite in another file: its symbol in its place (the image can't load the file)
          const href = node.getAttribute('href') ?? node.getAttribute('xlink:href');
          if (href && !href.startsWith('#')) {
            const symbol = await spriteElement(href, doc.baseURI);
            if (symbol) {
              const holder = scratch.createElementNS('http://www.w3.org/2000/svg', 'svg');
              for (const name of ['x', 'y', 'width', 'height', 'class', 'style']) {
                if (node.hasAttribute(name)) holder.setAttribute(name, node.getAttribute(name));
              }
              if (symbol.hasAttribute('viewBox')) holder.setAttribute('viewBox', symbol.getAttribute('viewBox'));
              for (const child of symbol.childNodes) holder.append(scratch.importNode(child, true));
              return holder;
            }
          }
        }

        // Its children: its shadow tree's (slots filled with what is slotted), else its own
        const append = async (child, inShadow) => {
          if (child.localName === 'slot' && inShadow) {
            const assigned = child.assignedNodes({ flatten: true });
            for (const slotted of assigned.length > 0 ? assigned : child.childNodes) {
              const copied = await copyOf(slotted, true);
              if (copied) copy.append(copied);
            }
            return;
          }
          const copied = await copyOf(child, inShadow || flattened);
          if (copied) copy.append(copied);
        };
        if (tag === 'textarea') {
          // Its value is its text (set above); its default text isn't drawn again
        } else if (node.shadowRoot) {
          watch(node.shadowRoot);
          for (const child of node.shadowRoot.childNodes) await append(child, true);
        } else {
          for (const child of node.childNodes) await append(child, flattened);
        }
        // Its ::before and ::after where they come from a shadow tree's rules (the document's sheets in
        // the image draw the rest: a slotted element's or a host's would be drawn twice)
        if (node.getRootNode() instanceof view.ShadowRoot) {
          for (const pseudo of ['::before', '::after']) {
            const pseudoStyle = view.getComputedStyle(node, pseudo);
            const text = pseudoText(pseudoStyle.content);
            if (text === null) continue;
            const span = scratch.createElement('span');
            span.setAttribute('style', await inlineUrls(computedStyleText(pseudoStyle), doc.baseURI));
            span.textContent = text;
            if (pseudo === '::before') copy.prepend(span);
            else copy.append(span);
          }
        }
        // A scrolled box shows the part scrolled to (its content moved instead: boxes by translate,
        // inline elements and text, which translate doesn't move, by relative position)
        if ((node.scrollTop || node.scrollLeft) && node !== root && node !== doc.body) {
          const dx = -node.scrollLeft;
          const dy = -node.scrollTop;
          for (const child of [...copy.childNodes]) {
            if (child.nodeType === Node.TEXT_NODE) {
              if (!child.data.trim()) continue;
              const span = scratch.createElement('span');
              span.setAttribute('style', `position:relative;left:${dx}px;top:${dy}px`);
              child.replaceWith(span);
              span.append(child);
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              const original = originals.get(child);
              const childStyle = original ? view.getComputedStyle(original) : null;
              if (childStyle?.display === 'inline' && childStyle.position === 'static') {
                child.style.setProperty('position', 'relative');
                child.style.setProperty('left', `${dx}px`);
                child.style.setProperty('top', `${dy}px`);
              } else {
                child.style.setProperty('translate', `${dx}px ${dy}px`);
              }
            }
          }
        }
        return copy;
      };

      const clone = await copyOf(root, false);
      if (view.scrollX || view.scrollY) {
        clone.querySelector('body')?.style.setProperty('translate', `${-view.scrollX}px ${-view.scrollY}px`);
      }
      let head = clone.querySelector('head');
      if (!head) {
        head = scratch.createElement('head');
        clone.prepend(head);
      }
      const sheet = scratch.createElement('style');
      sheet.textContent = `${await documentCss(doc, view)}\n*,*::before,*::after{animation:none!important;transition:none!important}`;
      head.append(sheet);

      const markup = new XMLSerializer().serializeToString(clone);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${docWidth}" height="${docHeight}"><foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = doc.createElement('canvas');
      canvas.width = Math.max(1, Math.round(docWidth * scale));
      canvas.height = Math.max(1, Math.round(docHeight * scale));
      const context = canvas.getContext('2d');
      context.scale(scale, scale);
      const background = [view.getComputedStyle(root).backgroundColor, doc.body && view.getComputedStyle(doc.body).backgroundColor]
        .find((color) => color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent');
      context.fillStyle = background || '#fff';
      context.fillRect(0, 0, docWidth, docHeight);
      context.drawImage(image, 0, 0, docWidth, docHeight);
      return canvas.toDataURL(doc === document ? 'image/jpeg' : 'image/png', quality);
    };

    return { data: await paintDocument(document, width, height) };
  }
}

/** Whether a popup's page can capture itself (its extension holds `<all_urls>`) */
const canCaptureItself = () => typeof browser !== 'undefined' && typeof browser.tabs?.captureTab === 'function' && typeof browser.tabs.getCurrent === 'function';

/**
 * Stream a popup the browser won't capture over WebDriver BiDi (see firefoxExtensionAction) while it
 * is viewed, by its own capture or drawn from its document: a frame at a time, each sent once the
 * last was drawn (as a screencast's are)
 */
function startTabCast(pageId, entry, cast) {
  if (cast.tabLoop) return;
  const loop = {};
  cast.tabLoop = loop;
  cast.size = { tab: true };
  const running = () => casts.get(pageId) === cast && cast.tabLoop === loop && cast.viewers.size > 0 && pages.get(pageId) === entry;
  void (async () => {
    let tabId = null;
    let failures = 0;
    let step = TAB_CAPTURE_STEP_MS;
    let lastData = '';
    while (running()) {
      const { width, height } = entry.popup;
      const scale = Math.max(1, ...cast.viewers.values());
      const capture = entry.tabCapture === 'capture';
      const shot = width > 0 && height > 0
        ? await bounded(
          (capture
            ? entry.page.evaluate(captureOwnTab, { tabId, width, height, scale })
            : entry.page.evaluate(paintSelf, { width, height, scale, quality: 0.92, force: !cast.framed })
          ).then((result) => result ?? false, () => null),
          TAB_CAPTURE_TIMEOUT_MS,
          null
        )
        : false;
      // A capture that keeps failing (its permission went, the tab isn't ready): drawn instead
      if (capture && shot === null && ++failures >= TAB_CAPTURE_FAILURES) {
        entry.tabCapture = 'paint';
        log('A popup\'s own capture keeps failing: drawn from its document instead');
      }
      if (shot) failures = 0;
      // The same picture as before: the next capture waits longer (until something changes or input comes)
      const recentInput = Date.now() - (entry.lastInputAt ?? 0) < 1000;
      if (shot && capture && shot.data === lastData && !recentInput) {
        step = Math.min(step * 2, TAB_CAPTURE_IDLE_STEP_MS);
        await sleep(step);
        continue;
      }
      step = TAB_CAPTURE_STEP_MS;
      if (shot && running()) {
        tabId = shot.tabId ?? null;
        lastData = String(shot.data);
        const data = Buffer.from(lastData.slice(lastData.indexOf(',') + 1), 'base64');
        cast.framed = true;
        await new Promise((done) => {
          const frame = { data, width, height };
          if (!cast.sending) sendFrame(pageId, cast, frame, done);
          else {
            cast.next?.done();
            cast.next = { frame, done };
          }
        });
      }
      await sleep(TAB_CAPTURE_STEP_MS);
    }
    if (cast.tabLoop === loop) {
      cast.tabLoop = null;
      cast.size = null;
    }
  })();
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
 * browsers get (chat-browsers.ts). The popup loads once behind the tab it opened for, as under the
 * browser's own popup (the extension acts on the active tab, which its popup asks for as it loads),
 * hidden from the drawer until measured (its size is its content's, as the browser sizes a popup).
 * Newer Firefox won't capture or drive such a page over BiDi: it then captures itself with its own
 * extension's tabs.captureTab (an extension holding `<all_urls>`), else is drawn from its document
 * (paintSelf), and its input goes in as DOM events (startTabCast, domInput). Juggler (Playwright's Firefox) ignores extension pages, so the tab's address, title, size and keys stay out of reach
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
  // Closed through a blank page (see closePage)
  added.extensionPage = true;
  // WebDriver BiDi can't set an extension page's viewport
  added.keepsViewport = true;
  try {
    await bounded(entry.page.bringToFront().catch(() => undefined), COMMAND_TIMEOUT_MS);
    // Loaded once, behind the page's tab, as under the browser's own popup: the extension acts on that
    // tab (it asks for the active tab of the last focused window as it loads). Never loaded again:
    // WebDriver BiDi reports no event of an extension page, so Playwright keeps the script context
    // its tab had, and a page loaded again answers nothing more. The first extension page a browser
    // loads may never give Playwright its script context: loaded once more then
    let measured = false;
    for (let attempt = 0; attempt < 2 && !measured && pages.has(id); attempt++) {
      await bounded(page.goto(popupUrl, { waitUntil: 'commit', timeout: COMMAND_TIMEOUT_MS }).catch(() => undefined), COMMAND_TIMEOUT_MS);
      measured = await settlePopupSize(id);
    }
    // A page that never answered takes no lookups (each would stay pending)
    added.privileged = !measured;
    // Newer Firefox refuses to capture or drive an extension's page ("browsing contexts in privileged
    // scope"): the page then captures itself (tabs.captureTab, the browser's own rendering) and its
    // input is replayed in it, as DOM events
    if (measured && (await captureRefused(page))) {
      added.domInput = true;
      // Its own capture, the browser's rendering, when its extension holds `<all_urls>`; else drawn
      // from its document (paintSelf)
      added.tabCapture = (await bounded(page.evaluate(canCaptureItself).catch(() => false), COMMAND_TIMEOUT_MS, false)) ? 'capture' : 'paint';
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

/**
 * Measure a popup until its size holds (its content may render a moment after it loads). A newer
 * call (another click in it) takes over from one still measuring
 */
async function settlePopupSize(pageId) {
  const token = {};
  const owner = pages.get(pageId);
  if (owner) owner.settling = token;
  let last = null;
  let until = Date.now() + POPUP_FIRST_MEASURE_MS;
  while (Date.now() < until && pages.get(pageId)?.popup && pages.get(pageId)?.settling === token) {
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
  // A tab that keeps its viewport is laid out at the width measured, as the browser's popup is (else
  // its page spreads over the whole tab, of which the drawer shows the corner)
  const size = await bounded(
    entry.page.evaluate(popupContentSize, { max: POPUP_MAX, pin: entry.keepsViewport === true }).catch(() => null),
    POPUP_MEASURE_TIMEOUT_MS,
    null
  );
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
 * widest its content lays out) and its height at that width, at most `max`. With `pin` the page is
 * then laid out at that width (its tab's viewport stays wider)
 */
function popupContentSize({ max, pin }) {
  const root = document.documentElement;
  const style = root.getAttribute('style');
  let width = 0;
  let height = 0;
  try {
    root.style.setProperty('width', 'max-content', 'important');
    width = Math.min(Math.ceil(root.getBoundingClientRect().width), max.width);
    root.style.setProperty('width', `${width}px`, 'important');
    root.style.setProperty('height', 'max-content', 'important');
    height = Math.min(Math.ceil(Math.max(root.getBoundingClientRect().height, root.scrollHeight)), max.height);
  } finally {
    if (style === null) root.removeAttribute('style');
    else root.setAttribute('style', style);
  }
  if (pin && width > 0) root.style.setProperty('width', `${width}px`, 'important');
  return { width, height, viewport: { width: innerWidth, height: innerHeight } };
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
  try {
    if (action === 'back') await page.goBack(options);
    else if (action === 'forward') await page.goForward(options);
    else if (action === 'reload') await page.reload(options);
    else if (action === 'goto' && url) await page.goto(url, options);
  } finally {
    // Where the tab is in its history now (a step may report no navigation)
    if (pages.get(pageId) === entry) void noteNavigation(entry).catch(() => undefined);
  }
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
