// Workbench CDP relay and keeper for Windows browsers driven from WSL
//
// Inside WSL2 with NAT networking, a Windows browser's DevTools port on the Windows 127.0.0.1
// can't be reached. windows-browser-launcher.cjs (in the distribution) starts this script with
// Workbench's own executable as Node (ELECTRON_RUN_AS_NODE=1) through WSL interop, so it runs on
// Windows, in one of two ways:
//
// `<port>`: once per connection Playwright opens; connects to the port and relays the bytes
// between it and its stdin/stdout.
//
// `--keep <port file> [<folder>]`: once per browser, started before it, for as long as the launcher
// runs. When its stdin ends (the launcher exited, or was killed without a chance to clean up) it
// reads the browser's DevTools port from the port file it writes (DevToolsActivePort; waiting for
// it a while, for a browser still starting), closes the browser over DevTools and removes the
// browser's temporary profile folder, if one is given. A number instead of the file is the port.
//
// Plain Node, no packages.
'use strict';
const fs = require('fs');
const net = require('net');

/** How long closing the browser may take before the folder is removed anyway */
const CLOSE_TIMEOUT_MS = 10_000;
/** How long the browser's files may stay held after it closed */
const REMOVE_TIMEOUT_MS = 15_000;
/** How long a browser still starting may take to write its port file */
const PORT_TIMEOUT_MS = 90_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function relay(port) {
  const socket = net.connect(port, '127.0.0.1');
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.on('end', () => socket.end());
  socket.on('close', () => process.exit(0));
  socket.on('error', () => process.exit(1));
}

async function closeBrowser(port) {
  if (typeof WebSocket !== 'function') return;
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    await new Promise((resolve) => {
      const ws = new WebSocket(version.webSocketDebuggerUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      ws.onclose = resolve;
      ws.onerror = resolve;
      setTimeout(resolve, CLOSE_TIMEOUT_MS);
    });
  } catch {
    // Already closed
  }
}

/** The browser's DevTools port: given, or read from its port file once it is written */
async function browserPort(portOrFile) {
  if (/^\d+$/.test(portOrFile)) return Number(portOrFile);
  const deadline = Date.now() + PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const port = Number(fs.readFileSync(portOrFile, 'utf-8').split('\n')[0]);
      if (port > 0) return port;
    } catch {
      // Not written yet
    }
    await sleep(250);
  }
  return 0;
}

function keep(portOrFile, folder) {
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    const port = await browserPort(portOrFile);
    if (port > 0) await closeBrowser(port);
    // The browser releases its files a moment after it exits
    const deadline = Date.now() + REMOVE_TIMEOUT_MS;
    while (folder && Date.now() < deadline) {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
    process.exit(0);
  };
  process.stdin.on('end', finish);
  process.stdin.on('close', finish);
  process.stdin.on('error', finish);
  process.stdin.resume();
}

const [first, second, third] = process.argv.slice(2);
if (first === '--keep') {
  if (!second) process.exit(2);
  keep(second, third);
} else {
  const port = Number(first);
  if (!(port > 0)) process.exit(2);
  relay(port);
}
