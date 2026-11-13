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
    const list = await Promise.all([...pages].filter(([, entry]) => !isHelperPage(entry.page)).map(async ([id, entry]) => ({
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
  page.on('close', () => {
    if (entry.loadingTimer) clearTimeout(entry.loadingTimer);
    pages.delete(id);
    dropCast(id);
    dropInput(id);
    pushPages();
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) pushPages();
  });
  page.on('load', pushPages);
  pushPages();
  return id;
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
    dropCast(id);
    dropInput(id);
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
  const viewport = entry.page.viewportSize() || { width: 1280, height: 720 };
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
          // The viewport in CSS pixels (Firefox reports the frame's device pixels as its viewport)
          const css = entry.page.viewportSize() || { width: viewportWidth, height: viewportHeight };
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
  if (switched) entry.page.bringToFront().catch(() => undefined);
  // The page fills the drawer: its viewport is the drawer's page area (what the agent sees too)
  if (width > 0 && height > 0) {
    const current = entry.page.viewportSize();
    if (!current || current.width !== width || current.height !== height) {
      const resized = entry.page.setViewportSize({ width, height }).catch((error) => log(error));
      // A resize that stalls: another tab came to the front since (Claude opened or picked one)
      if (!switched && !(await bounded(resized.then(() => true), RESIZE_STALL_MS, false))) {
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
  }
  queue.running = false;
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
/** Popups are at most this big (the browser's own limit), in CSS pixels; frames twice that */
const POPUP_MAX = { width: 800, height: 600 };
/** A Firefox popup's size: its content can't be measured (see extensionAction) */
const FIREFOX_POPUP = { width: 380, height: 560 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A session's browser-level CDP session (Chromium only), made once */
async function browserCdp(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('The browser is gone');
  if (!session.cdp) {
    const cdp = await session.browser.newBrowserCDPSession();
    session.cdp = cdp;
    session.popups = new Map();
    // Messages of the popups' own sessions (attached without flattening: playwright-core's CDP
    // session only speaks to the browser), and their end
    cdp.on('Target.receivedMessageFromTarget', (event) => session.popups.get(event.sessionId)?.receive(event.message));
    cdp.on('Target.detachedFromTarget', (event) => session.popups.get(event.sessionId)?.detached());
  }
  return session.cdp;
}

/** CDP key event fields for a key as the drawer names it (KeyboardEvent.key) */
const KEY_CODES = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Shift: 16, Control: 17, Alt: 18, Meta: 91,
};
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/**
 * An extension's popup as a page: the bridge streams and drives it like a tab (screencast frames,
 * mouse and keys), through its own CDP session. Popups size themselves to their content
 */
async function attachPopup(sessionId, targetId, url, title) {
  const session = sessions.get(sessionId);
  const cdp = await browserCdp(sessionId);
  const { sessionId: popupSession } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
  let nextId = 0;
  const waiting = new Map();
  const listeners = { close: [] };
  let closed = false;
  let size = { width: 0, height: 0 };
  let onFrame = null;
  let modifiers = 0;
  let pointer = { x: 0, y: 0 };
  let buttons = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('The popup closed'));
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    cdp.send('Target.sendMessageToTarget', { sessionId: popupSession, message: JSON.stringify({ id, method, params }) }).catch((error) => {
      waiting.delete(id);
      reject(error);
    });
  });
  const close = () => {
    if (closed) return;
    closed = true;
    session.popups.delete(popupSession);
    for (const { reject } of waiting.values()) reject(new Error('The popup closed'));
    waiting.clear();
    for (const listener of listeners.close) listener();
  };
  const resized = (width, height) => {
    if (!(width > 0 && height > 0) || (width === size.width && height === size.height)) return;
    size = { width: Math.min(width, POPUP_MAX.width), height: Math.min(height, POPUP_MAX.height) };
    pushPages();
  };
  session.popups.set(popupSession, {
    receive: (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id && waiting.has(message.id)) {
        const { resolve, reject } = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method === 'Page.screencastFrame') {
        const { data, metadata, sessionId: frameSession } = message.params;
        resized(Math.round(metadata.deviceWidth), Math.round(metadata.deviceHeight));
        const ack = () => call('Page.screencastFrameAck', { sessionId: frameSession }).catch(() => undefined);
        if (!onFrame) return void ack();
        Promise.resolve(onFrame({ data: new Uint8Array(Buffer.from(data, 'base64')), viewportWidth: size.width, viewportHeight: size.height })).then(ack, ack);
      }
    },
    detached: close,
  });
  const evaluate = async (fn, arg) => {
    const expression = typeof fn === 'function' ? `(${fn})(${JSON.stringify(arg)})` : String(fn);
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed');
    return result.result.value;
  };
  const mouse = (type, extra = {}) => call('Input.dispatchMouseEvent', { type, x: pointer.x, y: pointer.y, modifiers, buttons, ...extra });
  const BUTTON_BITS = { left: 1, right: 2, middle: 4 };
  const key = (type, name) => {
    const code = KEY_CODES[name] ?? ([...name].length === 1 ? name.toUpperCase().charCodeAt(0) : 0);
    // Printable keys type their character, unless a shortcut modifier is down
    const text = [...name].length === 1 && !(modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt)) ? name : name === 'Enter' ? '\r' : '';
    return call('Input.dispatchKeyEvent', {
      type: type === 'down' ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      key: name,
      windowsVirtualKeyCode: code,
      modifiers,
      ...(type === 'down' && text ? { text, unmodifiedText: text } : {}),
    });
  };
  const page = {
    url: () => url,
    title: async () => title,
    on: (event, listener) => {
      if (event === 'close') listeners.close.push(listener);
    },
    mainFrame: () => ({ evaluate, childFrames: () => [] }),
    evaluate,
    context: () => {
      throw new Error('A popup has no context');
    },
    emulateMedia: async ({ colorScheme: scheme }) => {
      await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }).catch(() => undefined);
    },
    viewportSize: () => (size.width > 0 ? size : null),
    // A popup sizes itself to its content
    setViewportSize: async () => undefined,
    bringToFront: async () => undefined,
    screencast: {
      start: async (options) => {
        onFrame = options.onFrame;
        await call('Page.startScreencast', { format: 'jpeg', quality: options.quality ?? 100, maxWidth: POPUP_MAX.width * 2, maxHeight: POPUP_MAX.height * 2 });
      },
      stop: async () => {
        onFrame = null;
        await call('Page.stopScreencast').catch(() => undefined);
      },
    },
    mouse: {
      move: async (x, y) => {
        pointer = { x, y };
        await mouse('mouseMoved');
      },
      down: async ({ button = 'left', clickCount = 1 } = {}) => {
        buttons |= BUTTON_BITS[button] ?? 1;
        await mouse('mousePressed', { button, clickCount });
      },
      up: async ({ button = 'left', clickCount = 1 } = {}) => {
        buttons &= ~(BUTTON_BITS[button] ?? 1);
        await mouse('mouseReleased', { button, clickCount });
      },
      wheel: async (deltaX, deltaY) => mouse('mouseWheel', { deltaX, deltaY }),
    },
    keyboard: {
      down: async (name) => {
        modifiers |= MODIFIER_BITS[name] ?? 0;
        await key('down', name);
      },
      up: async (name) => {
        modifiers &= ~(MODIFIER_BITS[name] ?? 0);
        await key('up', name);
      },
      insertText: (text) => call('Input.insertText', { text }),
    },
    goBack: async () => undefined,
    goForward: async () => undefined,
    reload: async () => call('Page.reload'),
    goto: async () => undefined,
    close: async () => {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
      close();
    },
  };
  // Its size before the first frame
  const initial = await evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null);
  if (initial) resized(initial.width, initial.height);
  return page;
}

/** One popup at a time, as in the browser */
function closePopups(sessionId) {
  for (const other of pages.values()) {
    if (other.popup && other.sessionId === sessionId) other.page.close().catch(() => undefined);
  }
}

/** Open a page in a new tab of the page's browser, for the drawer (not navigated yet) */
async function openTab(entry) {
  const page = await entry.page.context().newPage();
  const id = pageIds.get(page) ?? addPage(page, entry.sessionId);
  return { page, id, added: pages.get(id) };
}

/**
 * Firefox: its popup can't open as one (Playwright's Firefox has no way to its toolbar), so the
 * popup's page opens in a new tab the drawer shows as the popup, at a popup's size. Juggler ignores
 * extension pages, so the tab's address, title and keys stay out of reach: only the mouse drives it
 * (its frames and clicks go through the browser window). An extension without a popup opens its
 * homepage in a new tab instead
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
  if (added) {
    added.popup = { extensionId, openerId: pageId, ...FIREFOX_POPUP };
    added.mouseOnly = true;
    added.title = String(name || '');
  }
  pushPages();
  // Never reported as loaded (see above): its frames show it once it has
  page.goto(popupUrl, { waitUntil: 'commit', timeout: 5000 }).catch(() => undefined);
  return id;
}

/**
 * Click an extension's toolbar button for a page (Chromium's Extensions.triggerAction, as the
 * browser's own button does: its popup opens for that tab, or the extension's click handler runs).
 * A popup is streamed like a page (marked with its extension and the page it opened for); the
 * drawer shows it over that page. Answers with the popup's page id, if one opened
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
      const page = await attachPopup(entry.sessionId, popup.targetId, popup.url, String(name || ''));
      const popupId = addPage(page, entry.sessionId, { extensionId, openerId: pageId });
      send({ type: 'extensionActionDone', id: requestId, popupId });
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
      pages.get(message.pageId)?.page.close().catch(log);
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
