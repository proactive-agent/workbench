/**
 * The launcher and the relay for Windows browsers in WSL, run for real with a fake browser and a
 * fake Playwright server: Node stands in for Workbench's executable (the relay's Node) and the
 * browser is a script that serves DevTools' /json/version and exits when a DevTools client
 * connects (as Browser.close would close it)
 */
import { spawn } from 'child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isWindows } from '../../platform';

const LAUNCHER = path.join(__dirname, '..', 'windows-browser-launcher.cjs');
const RELAY = path.join(__dirname, '..', 'windows-cdp-relay.cjs');

const FAKE_BROWSER = `#!/usr/bin/env node
const fs = require('fs'); const http = require('http'); const path = require('path');
const dir = process.argv.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
const server = http.createServer((req, res) => {
  const port = server.address().port;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ Browser: 'Fake/1.0', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/fake' }));
});
server.on('upgrade', (req, socket) => { socket.destroy(); process.exit(0); });
server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), server.address().port + '\\n/devtools/browser/fake'));
process.on('SIGTERM', () => process.exit(0));
`;

const FAKE_SERVER = `
const endpoint = process.argv[process.argv.indexOf('--cdp-endpoint') + 1];
fetch(endpoint + '/json/version').then((r) => r.json()).then((v) => { process.stdout.write('VERSION ' + JSON.stringify(v) + '\\n'); process.exit(0); },
  (e) => { process.stdout.write('FAILED ' + e.message + '\\n'); process.exit(1); });
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'windows-browser-launcher-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.on('exit', (code) => resolve({ code, stdout }));
  });
}

describe('windows-browser-launcher', () => {
  it.skipIf(isWindows())('starts the browser, relays its DevTools port to the server and cleans up after it', async () => {
    const browser = path.join(dir, 'fake-browser.cjs');
    await writeFile(browser, FAKE_BROWSER);
    await chmod(browser, 0o755);
    const fakeServer = path.join(dir, 'fake-server.cjs');
    await writeFile(fakeServer, FAKE_SERVER);
    const tempDir = path.join(dir, 'tmp');
    await mkdir(tempDir);
    const argsFile = path.join(dir, 'browser-args.json');
    const config = {
      executable: browser,
      args: ['--profile-directory=Default'],
      tempDir: { windows: tempDir, runtime: tempDir },
      relay: { command: process.execPath, script: RELAY },
    };

    const { code, stdout } = await run([LAUNCHER, JSON.stringify(config), process.execPath, fakeServer], { ...process.env, FAKE_ARGS_FILE: argsFile });

    // The server reached the browser's DevTools through the listener and the relay
    expect(stdout).toContain('VERSION');
    expect(JSON.parse(stdout.slice(stdout.indexOf('{'))).Browser).toBe('Fake/1.0');
    expect(code).toBe(0);
    const browserArgs = JSON.parse(await readFile(argsFile, 'utf-8')) as string[];
    expect(browserArgs).toEqual(expect.arrayContaining([
      '--profile-directory=Default', '--remote-debugging-port=0', '--headless', '--no-startup-window',
    ]));
    expect(browserArgs.find((a) => a.startsWith('--user-data-dir='))).toMatch(/workbench-windows-browser-/);
    // The keeper closed the browser and removed its temporary profile
    expect(await readdir(tempDir)).toEqual([]);
  }, 30_000);
});
