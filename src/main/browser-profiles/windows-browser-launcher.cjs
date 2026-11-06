// Workbench's launcher for Windows browsers driven from WSL
//
// While tools run in WSL, Playwright runs inside the distribution, where it can't start a Windows
// browser itself (it talks to the browsers it launches over pipes, which WSL interop doesn't
// carry). So this script, run by the distribution's node as the Playwright MCP server's command:
// 1. starts the Windows browser (by its /mnt path, through interop) on the run's profile copy, or
//    on a new profile in a temporary folder, with a DevTools port, headless and no first tab;
// 2. starts the keeper (windows-cdp-relay.cjs --keep, on Windows) right after the browser, with the
//    browser's port file, so it closes the browser and removes its temporary profile once this
//    script is gone, also when it is killed or gave up on a browser slow to start;
// 3. listens on the distribution's 127.0.0.1 and relays each connection to the browser's port
//    through windows-cdp-relay.cjs, run on Windows by Workbench's own executable as Node (the
//    Windows 127.0.0.1 can't be reached from WSL2 with NAT networking);
// 4. starts the server (the rest of its arguments) with `--cdp-endpoint` set to that listener, and
//    closes the browser when the server exits.
//
// Its first argument is a JSON config: { executable, args, userDataDir?: { windows, runtime },
// tempDir: { windows, runtime }, relay: { command, script } } (`windows` paths for the Windows
// processes, `runtime` ones for this script). Plain Node, no packages.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

/** How long the browser may take to write its DevTools port */
const START_TIMEOUT_MS = 60_000;
/** How long the keeper may take to close the browser and remove its temporary profile */
const KEEPER_TIMEOUT_MS = 20_000;

const config = JSON.parse(process.argv[2] || '{}');
const [serverCommand, ...serverArgs] = process.argv.slice(3);

const log = (text) => process.stderr.write(`[Workbench] ${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser = null;
let server = null;
/** The keeper's input: ending it tells the keeper to close the browser */
let keeperInput = null;
/** The temporary profile (runtime and Windows paths), when the run has no profile copy */
let tempProfile = null;
let finished = false;

/** The profile folder: the run's copy, or a new one in the temporary folder (removed at the end) */
function profileFolder() {
  if (config.userDataDir) return config.userDataDir;
  const runtime = fs.mkdtempSync(path.posix.join(config.tempDir.runtime, 'workbench-windows-browser-'));
  // Joined the way the folder is written (backslashes on Windows)
  const separator = config.tempDir.windows.includes('\\') ? '\\' : '/';
  tempProfile = { runtime, windows: `${config.tempDir.windows.replace(/[\\/]+$/, '')}${separator}${path.posix.basename(runtime)}` };
  return tempProfile;
}

/** The browser's port file as the keeper (on Windows) finds it */
function windowsPortFile(profile) {
  const separator = profile.windows.includes('\\') ? '\\' : '/';
  return `${profile.windows.replace(/[\\/]+$/, '')}${separator}DevToolsActivePort`;
}

async function devToolsPort(file) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (browser && browser.exitCode !== null) throw new Error(`the browser exited (code ${browser.exitCode})`);
    try {
      const port = Number(fs.readFileSync(file, 'utf-8').split('\n')[0]);
      if (port > 0) return port;
    } catch {
      // Not written yet
    }
    await sleep(200);
  }
  throw new Error('the browser did not open its DevTools port in time');
}

/** Workbench's executable runs the relay script as Node (the variable reaches it through WSLENV) */
const RELAY_ENV = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  WSLENV: [process.env.WSLENV, 'ELECTRON_RUN_AS_NODE'].filter(Boolean).join(':'),
};

function startRelay(args, stdio) {
  return spawn(config.relay.command, [config.relay.script, ...args], { env: RELAY_ENV, stdio });
}

/**
 * The keeper, started through a shell that leaves it running in the background: not a child of
 * this script, so stopping this script's children (Workbench stops a WSL process with
 * `pkill -P` too) leaves it to clean up. Its input is a pipe this script holds (fd 3 of the
 * shell), which ends when this script exits or is killed
 */
function startKeeper(args) {
  const shell = spawn('/bin/sh', ['-c', '"$@" <&3 3<&- >/dev/null 2>&1 &', 'sh', config.relay.command, config.relay.script, '--keep', ...args], {
    env: RELAY_ENV,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    detached: true,
  });
  shell.on('error', (error) => log(`The browser's keeper did not start: ${error.message}`));
  const input = shell.stdio[3];
  input.on('error', () => undefined);
  return input;
}

/** One relay process per connection: the Windows side connects to the browser's port */
function relayConnection(socket, port) {
  const relay = startRelay([String(port)], ['pipe', 'pipe', 'ignore']);
  socket.pipe(relay.stdin);
  relay.stdout.pipe(socket);
  relay.stdin.on('error', () => socket.destroy());
  socket.on('error', () => relay.kill());
  socket.on('close', () => relay.stdin.end());
  relay.on('exit', () => socket.destroy());
  relay.on('error', (error) => {
    log(`The CDP relay did not start: ${error.message}`);
    socket.destroy();
  });
}

function relayListener(port) {
  return new Promise((resolve, reject) => {
    const listener = net.createServer((socket) => relayConnection(socket, port));
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve(listener));
  });
}

/** Let the keeper close the browser and remove the temporary profile; wait until that is done */
async function stopBrowser() {
  keeperInput?.end();
  const deadline = Date.now() + KEEPER_TIMEOUT_MS;
  const pending = () => (browser && browser.exitCode === null) || (tempProfile && fs.existsSync(tempProfile.runtime));
  while (keeperInput && pending() && Date.now() < deadline) await sleep(200);
  // Left over (no keeper, or it couldn't): stop the browser's interop process and remove the folder here
  if (browser && browser.exitCode === null) browser.kill();
  if (tempProfile && fs.existsSync(tempProfile.runtime)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(tempProfile.runtime, { recursive: true, force: true });
        break;
      } catch {
        await sleep(500);
      }
    }
  }
}

async function finish(code) {
  if (finished) return;
  finished = true;
  if (server && server.exitCode === null) server.kill();
  await stopBrowser();
  process.exit(code);
}

async function main() {
  const profile = profileFolder();
  const portFile = path.posix.join(profile.runtime, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  browser = spawn(config.executable, [
    `--user-data-dir=${profile.windows}`,
    ...(config.args || []),
    '--remote-debugging-port=0',
    '--headless',
    '--no-first-run',
    '--no-default-browser-check',
    // Edge may restart itself on Windows (its compatibility relaunch), which this script would take
    // for the browser exiting (Playwright passes it for the same reason)
    '--edge-skip-compat-layer-relaunch',
    // No first tab: Playwright opens the pages itself (its screencast, which the drawer streams,
    // gets no frames from a tab the browser opened before Playwright attached)
    '--no-startup-window',
    // Edge publishes its tabs to Windows' Alt+Tab (Windows.UI.Shell.WindowTabManager), headless
    // too: they would show there while it runs, and stay there when it is killed
    '--disable-features=msWindowTabManagerPublic',
  ], { stdio: 'ignore' });
  browser.on('error', (error) => log(`The browser did not start: ${error.message}`));
  // Before the port is known: a browser that starts after this script gave up on it is still closed
  keeperInput = startKeeper([windowsPortFile(profile), ...(tempProfile ? [tempProfile.windows] : [])]);
  let port;
  try {
    port = await devToolsPort(portFile);
  } catch (error) {
    log(`Could not start ${config.executable}: ${error.message}`);
    return finish(1);
  }
  const listener = await relayListener(port);
  const endpoint = `http://127.0.0.1:${listener.address().port}`;
  server = spawn(serverCommand, [...serverArgs, '--cdp-endpoint', endpoint], { stdio: 'inherit' });
  server.on('error', (error) => {
    log(`The Playwright server did not start: ${error.message}`);
    void finish(1);
  });
  server.on('exit', (code) => void finish(code ?? 0));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void finish(0));
  // The browser went away (closed or crashed): the server has nothing left to drive
  browser.on('exit', () => void finish(0));
}

main().catch((error) => {
  log(String(error && error.message ? error.message : error));
  void finish(1);
});
