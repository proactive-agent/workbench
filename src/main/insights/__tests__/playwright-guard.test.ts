/**
 * The chat's Playwright guard (playwright-guard.cjs), run with Node against a fake server: the
 * server runs in the given folder without the client's roots, so that folder is its workspace
 * root, and the tool that runs Node.js code is left out and refused
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUARD = join(__dirname, '..', 'playwright-guard.cjs');
const root = mkdtempSync(join(tmpdir(), 'playwright-guard-test-'));
const fakeServer = join(root, 'fake-server.cjs');
writeFileSync(fakeServer, `
let buffer = '';
process.stdin.on('data', (data) => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    if (message.method === 'initialize') reply({ capabilities: message.params.capabilities, cwd: process.cwd() });
    else if (message.method === 'tools/list') reply({ tools: [{ name: 'browser_navigate' }, { name: 'browser_run_code_unsafe' }] });
    else if (message.method === 'tools/call') reply({ content: [{ type: 'text', text: 'called ' + message.params.name }] });
  }
});
`);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Playwright guard', () => {
  it("starts the server in the turn's folder without the client's roots and leaves out the Node.js code tool", async () => {
    const workspace = mkdtempSync(join(root, 'turn-'));
    const proc = spawn(process.execPath, [GUARD, workspace, process.execPath, fakeServer], { stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = new Map<number, Record<string, unknown>>();
    let buffer = '';
    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        replies.set(message.id, message.result);
      }
    });
    const send = (message: Record<string, unknown>) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    send({ id: 1, method: 'initialize', params: { capabilities: { roots: { listChanged: true }, elicitation: {} } } });
    send({ method: 'notifications/roots/list_changed' });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'browser_run_code_unsafe', arguments: { code: 'process.exit()' } } });
    send({ id: 4, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'about:blank' } } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answers')), 10_000);
      const poll = setInterval(() => {
        if (replies.size < 4) return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }, 20);
    });
    proc.stdin.end();

    const initialized = replies.get(1) as { capabilities: unknown; cwd: string };
    expect(initialized.capabilities).toEqual({ elicitation: {} });
    expect(realpathSync.native(initialized.cwd)).toBe(realpathSync.native(workspace));
    expect(replies.get(2)).toEqual({ tools: [{ name: 'browser_navigate' }] });
    expect(replies.get(3)).toMatchObject({ isError: true });
    expect(replies.get(4)).toEqual({ content: [{ type: 'text', text: 'called browser_navigate' }] });
  });

  it("asks Workbench to open the chat's browser before each tool call, and keeps it open", async () => {
    let opens = 0;
    let fail = false;
    const auth: string[] = [];
    const server = createServer((request, response) => {
      auth.push(request.headers.authorization ?? '');
      opens += 1;
      const result = fail ? { isError: true, content: [{ type: 'text', text: 'Chromium is not installed' }] } : { content: [{ type: 'text', text: 'open' }] };
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    const workspace = mkdtempSync(join(root, 'turn-'));
    const proc = spawn(process.execPath, [GUARD, workspace, process.execPath, fakeServer], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, WORKBENCH_CHAT_BROWSER_URL: url, WORKBENCH_CHAT_BROWSER_TOKEN: 'secret' },
    });
    const replies = new Map<number, Record<string, unknown>>();
    let buffer = '';
    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        replies.set(message.id, message.result);
      }
    });
    const send = (message: Record<string, unknown>) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    const answered = (count: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answers')), 10_000);
      const poll = setInterval(() => {
        if (replies.size < count) return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }, 20);
    });
    send({ id: 1, method: 'initialize', params: { capabilities: {} } });
    send({ id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'about:blank' } } });
    send({ id: 3, method: 'tools/call', params: { name: 'browser_close', arguments: {} } });
    await answered(3);
    fail = true;
    send({ id: 4, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } });
    await answered(4);
    proc.stdin.end();
    await new Promise((resolve) => server.close(resolve));

    // Opened (asked for) before the tool call only, with the turn's token; initialize asks nothing
    expect(opens).toBe(2);
    expect(auth[0]).toBe('Bearer secret');
    expect(replies.get(2)).toEqual({ content: [{ type: 'text', text: 'called browser_navigate' }] });
    expect(replies.get(3)).toMatchObject({ isError: true });
    expect(JSON.stringify(replies.get(4))).toContain('Chromium is not installed');
    expect(replies.get(4)).toMatchObject({ isError: true });
  });

  it('opens the chat browser through the relay (WSL NAT): started once, given the token, answers each call', async () => {
    const log = join(root, 'relay-log.txt');
    const relayScript = join(root, 'fake-relay.cjs');
    writeFileSync(relayScript, `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, 'start ' + process.env.WORKBENCH_TASK_TOOLS_TOKEN + ' ' + process.env.WORKBENCH_TASK_TOOLS_URL + '\\n');
let buffer = '';
process.stdin.on('data', (data) => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    fs.appendFileSync(${JSON.stringify(log)}, 'call ' + message.params.name + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'open' }] } }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`);
    const workspace = mkdtempSync(join(root, 'turn-'));
    const proc = spawn(process.execPath, [GUARD, workspace, process.execPath, fakeServer], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        WORKBENCH_CHAT_BROWSER_URL: 'http://127.0.0.1:1/mcp',
        WORKBENCH_CHAT_BROWSER_TOKEN: 'secret',
        WORKBENCH_CHAT_BROWSER_RELAY: JSON.stringify({ command: process.execPath, script: relayScript }),
      },
    });
    const replies = new Map<number, Record<string, unknown>>();
    let buffer = '';
    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        replies.set(message.id, message.result);
      }
    });
    const send = (message: Record<string, unknown>) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    send({ id: 1, method: 'initialize', params: { capabilities: {} } });
    send({ id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'about:blank' } } });
    send({ id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answers')), 10_000);
      const poll = setInterval(() => {
        if (replies.size < 3) return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }, 20);
    });
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.stdin.end();
    await exited;

    expect(replies.get(2)).toEqual({ content: [{ type: 'text', text: 'called browser_navigate' }] });
    expect(replies.get(3)).toEqual({ content: [{ type: 'text', text: 'called browser_snapshot' }] });
    const lines = readFileSync(log, 'utf-8').trim().split('\n');
    expect(lines).toEqual(['start secret http://127.0.0.1:1/mcp', 'call open_chat_browser', 'call open_chat_browser']);
  });
});
