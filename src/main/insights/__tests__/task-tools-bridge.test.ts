/**
 * The task tools stdio bridge (task-tools-bridge.cjs), run with Node against the real task tools
 * server (tools mocked) and against a server that answers with server-sent events
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

vi.mock('../task-tools', () => ({
  TASK_TOOLS: [{ name: 'list_tasks', description: 'List tasks', inputSchema: { type: 'object' }, mutates: false }],
  runTaskTool: async (_context: unknown, name: string, args: Record<string, unknown>) => ({ ran: name, args }),
}));

import { closeTaskToolsServer, openChatToolsSession } from '../task-tools-server';
import { TASK_TOOLS_BRIDGE_TOKEN_ENV, TASK_TOOLS_BRIDGE_URL_ENV, toBridgeServer } from '../task-tools-mcp';

const BRIDGE = join(__dirname, '..', 'task-tools-bridge.cjs');

/** Run the bridge with these stdin lines; resolves with the lines it wrote once it exited */
function runBridge(env: Record<string, string>, lines: unknown[]): Promise<{ messages: Array<Record<string, any>>; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ messages: stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)), code });
    });
    // Closing stdin right away: answers still on their way are written before the bridge exits
    child.stdin.end(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  });
}

const bridgeEnv = (url: string, token: string) => ({ [TASK_TOOLS_BRIDGE_URL_ENV]: url, [TASK_TOOLS_BRIDGE_TOKEN_ENV]: token });

afterAll(() => closeTaskToolsServer());

describe('task tools bridge', () => {
  it('relays requests and responses between stdio and the task tools server', async () => {
    const session = await openChatToolsSession({ tasks: { projectId: 'p1', onTasksChanged: () => undefined } });
    const entry = toBridgeServer(session.mcpServer, '/mnt/c/Workbench.exe', 'C:\\temp\\task-tools-bridge.cjs');
    const { messages, code } = await runBridge(bridgeEnv(entry.env.WORKBENCH_TASK_TOOLS_URL, entry.env.WORKBENCH_TASK_TOOLS_TOKEN), [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tasks', arguments: { status: 'done' } } },
    ]);
    session.close();

    expect(code).toBe(0);
    const byId = new Map(messages.map((message) => [message.id, message]));
    // The notification gets no answer
    expect(messages).toHaveLength(3);
    expect(byId.get(1)?.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'workbench' } });
    expect(byId.get(2)?.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_tasks']);
    expect(JSON.parse(byId.get(3)?.result.content[0].text)).toEqual({ ran: 'list_tasks', args: { status: 'done' } });
  });

  it('answers requests with an error when the token is not accepted', async () => {
    const session = await openChatToolsSession({ tasks: { projectId: 'p1', onTasksChanged: () => undefined } });
    session.close();
    const { url } = session.mcpServer;
    const { messages } = await runBridge(bridgeEnv(url, 'wrong'), [{ jsonrpc: '2.0', id: 7, method: 'ping' }]);
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 7, error: { code: -32000, message: expect.stringContaining('401') } }]);
  });

  it('answers requests with an error when the server is unreachable', async () => {
    const { messages } = await runBridge(bridgeEnv('http://127.0.0.1:1/mcp', 'x'), [{ jsonrpc: '2.0', id: 'a', method: 'ping' }]);
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 'a', error: { code: -32000, message: expect.stringContaining('unreachable') } }]);
  });

  it('relays server-sent event responses and returns the session id the server gave', async () => {
    const seenSessionIds: Array<string | undefined> = [];
    const server: Server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        seenSessionIds.push(request.headers['mcp-session-id'] as string | undefined);
        const message = JSON.parse(body);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'session-1' });
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: message.id } })}\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    try {
      const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, ...bridgeEnv(url, 't') }, stdio: ['pipe', 'pipe', 'pipe'] });
      const lines: Array<Record<string, any>> = [];
      let stdout = '';
      const waitFor = (id: number) => new Promise<void>((resolve) => {
        const check = () => {
          if (lines.some((line) => line.id === id)) resolve();
          else setTimeout(check, 10);
        };
        check();
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const parts = stdout.split('\n');
        stdout = parts.pop() ?? '';
        for (const part of parts) if (part) lines.push(JSON.parse(part));
      });
      const exited = new Promise((resolve) => child.on('exit', resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
      await waitFor(1);
      child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      await waitFor(2);
      await exited;

      expect(lines).toEqual([
        { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
        { jsonrpc: '2.0', id: 1, result: { ok: 1 } },
        { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
        { jsonrpc: '2.0', id: 2, result: { ok: 2 } },
      ]);
      expect(seenSessionIds).toEqual([undefined, 'session-1']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
