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
// (`page.screencast`), sizes a viewed page's viewport to the drawer, and replays the viewer's
// mouse, wheel and keys on it; it also says which registry endpoints answer (`probe`), for WSL
// mode, where the main process can't reach the sockets. Plain Node, no packages of its own.
'use strict';
const net = require('net');

/** session id -> { browser, key } */
const sessions = new Map();
/** page id -> { page, sessionId } */
const pages = new Map();
const pageIds = new WeakMap();
let nextPageId = 1;
/** How long connecting to a browser may take */
const CONNECT_TIMEOUT_MS = 15000;
/**
 * page id -> { viewers: Map<viewer id, scale>, size: the frame size asked for | null }. Frames are
 * asked at the viewport times the largest viewer's devicePixelRatio, so they are sharp on HiDPI
 * screens (browsers render that many pixels only when launched for it: mcp-config.ts)
 */
const casts = new Map();
/** viewer id -> page id */
const viewers = new Map();

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
/** Whether the channel is still writing earlier output (a frame is dropped then, not queued) */
const outputBusy = () => process.stdout.writableNeedDrain;
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
  const viewport = entry.page.viewportSize() || { width: 1280, height: 720 };
  const scale = Math.max(1, ...cast.viewers.values());
  const size = { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
  if (cast.size && cast.size.width === size.width && cast.size.height === size.height) return;
  if (cast.size) {
    await entry.page.screencast.stop().catch(() => undefined);
    cast.size = null;
  }
  await entry.page.screencast.start({
    size,
    // The best JPEG quality: lower ones blur small text (frames are local, so their size matters little)
    quality: 100,
    onFrame: ({ data, viewportWidth, viewportHeight }) => {
      const current = casts.get(pageId);
      if (!current || current.viewers.size === 0 || outputBusy()) return;
      // The viewport in CSS pixels (Firefox reports the frame's device pixels as its viewport)
      const css = entry.page.viewportSize() || { width: viewportWidth, height: viewportHeight };
      send({ type: 'frame', pageId, viewers: [...current.viewers.keys()], data, width: css.width, height: css.height });
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
  // The page fills the drawer: its viewport is the drawer's page area (what the agent sees too)
  if (width > 0 && height > 0) {
    const current = entry.page.viewportSize();
    if (!current || current.width !== width || current.height !== height) {
      await entry.page.setViewportSize({ width, height }).catch((error) => log(error));
    }
  }
  let cast = casts.get(pageId);
  if (!cast) {
    cast = { viewers: new Map(), size: null };
    casts.set(pageId, cast);
  }
  cast.viewers.set(viewerId, Number.isFinite(scale) && scale >= 1 ? Math.min(scale, 2) : 1);
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
    case 'probe':
      // Not queued: answered while a slow connect runs
      probe(message.id, message.endpoints).catch(log);
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
