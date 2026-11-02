/**
 * The chat's Playwright guard (playwright-guard.cjs), run with Node against a fake server: the
 * server runs in the given folder without the client's roots, so that folder is its workspace
 * root, and the tool that runs Node.js code is left out and refused
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
});
