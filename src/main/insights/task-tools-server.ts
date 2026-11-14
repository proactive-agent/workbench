/**
 * Task tools server
 * =================
 *
 * Serves the Claude chat's task tools (`task-tools.ts`) to its Claude Code session as an MCP
 * server over HTTP (MCP Streamable HTTP, plain JSON responses), on 127.0.0.1 only.
 *
 * Each chat turn gets its own bearer token, which names the project the tools act on and stops
 * working when the turn ends. Task runs get tokens too (`openMcpToolsSession`): they see their
 * own tool list (task messaging), never the chat's task management tools.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { TASK_TOOLS, runTaskTool, type TaskToolContext } from './task-tools';
import { SESSION_TOOLS, runSessionTool, type SessionToolContext } from '../session-messaging/tools';
import { TASK_TOOLS_SERVER_NAME, type TaskToolsMcpServer } from './task-tools-mcp';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 1024 * 1024;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** The task tools of one chat turn */
export interface TaskToolsSession {
  mcpServer: TaskToolsMcpServer;
  /** Stop accepting the session's token */
  close: () => void;
}

/** A tool as `tools/list` describes it */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** What one token gives access to: its tools and how to run them */
export interface McpToolsProvider {
  instructions: string;
  tools: McpToolDescriptor[];
  /** Run a tool; a string result is sent as is, anything else as JSON. Throws for a tool error */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

const sessions = new Map<string, McpToolsProvider>();

/** The chat's task tools for a project */
function insightsProvider(context: TaskToolContext): McpToolsProvider {
  return {
    instructions: "Manage this project's Workbench tasks.",
    tools: TASK_TOOLS.map(({ name, description, inputSchema, mutates }) => ({
      name,
      description,
      inputSchema,
      annotations: { readOnlyHint: !mutates, destructiveHint: name === 'delete_task' || name === 'retry_task' },
    })),
    call: (name, args) => runTaskTool(context, name, args),
  };
}
let server: Server | null = null;
let listening: Promise<number> | null = null;

function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Answer one JSON-RPC message; notifications get no answer */
async function handleMessage(provider: McpToolsProvider, message: JsonRpcRequest): Promise<unknown | undefined> {
  const isNotification = message.id === undefined;
  switch (message.method) {
    case 'initialize': {
      const requested = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '';
      return rpcResult(message.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: TASK_TOOLS_SERVER_NAME, version: '1.0.0' },
        instructions: provider.instructions,
      });
    }
    case 'ping':
      return rpcResult(message.id, {});
    case 'tools/list':
      return rpcResult(message.id, { tools: provider.tools });
    case 'tools/call': {
      const name = String(message.params?.name ?? '');
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await provider.call(name, args);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return rpcResult(message.id, { content: [{ type: 'text', text }] });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return rpcResult(message.id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return isNotification ? undefined : rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  const provider = token ? sessions.get(token) : undefined;
  if (!provider) return send(response, 401, rpcError(null, -32001, 'Unauthorized'));
  // Only JSON-RPC over POST: no server-initiated stream
  if (request.method !== 'POST') return send(response, 405);

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = JSON.parse(await readBody(request)) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return send(response, 400, rpcError(null, -32700, 'Parse error'));
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  const answers = (await Promise.all(messages.map((message) => handleMessage(provider, message)))).filter((answer) => answer !== undefined);
  if (answers.length === 0) return send(response, 202);
  send(response, 200, Array.isArray(payload) ? answers : answers[0]);
}

function ensureServer(): Promise<number> {
  if (listening) return listening;
  listening = new Promise((resolve, reject) => {
    server = createServer((request, response) => {
      handleRequest(request, response).catch((error) => {
        if (!response.headersSent) send(response, 500, rpcError(null, -32603, error instanceof Error ? error.message : String(error)));
      });
    });
    server.once('error', (error) => {
      listening = null;
      server = null;
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
  });
  return listening;
}

/** The messaging tools of a chat turn or an agent window (session-messaging/tools.ts) */
export function sessionToolsProvider(context: SessionToolContext): McpToolsProvider {
  return {
    instructions: "Message this Workbench project's Claude chats and agent windows.",
    tools: SESSION_TOOLS.map(({ name, description, inputSchema, readOnly }) => ({
      name,
      description,
      inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false },
    })),
    call: (name, args) => runSessionTool(context, name, args),
  };
}

/**
 * Open a chat turn's Workbench tools: the task tools (the Kanban button) and the messaging tools
 * (Settings > Agents), either or both
 */
export function openChatToolsSession(options: { tasks?: TaskToolContext; messaging?: SessionToolContext }): Promise<TaskToolsSession> {
  const parts = [
    ...(options.tasks ? [insightsProvider(options.tasks)] : []),
    ...(options.messaging ? [sessionToolsProvider(options.messaging)] : []),
  ];
  return openMcpToolsSession({
    instructions: parts.map((part) => part.instructions).join(' '),
    tools: parts.flatMap((part) => part.tools),
    call: (name, args) => {
      const part = parts.find((candidate) => candidate.tools.some((tool) => tool.name === name));
      if (!part) throw new Error(`Unknown tool: ${name}`);
      return part.call(name, args);
    },
  });
}

/** Open a token for any set of tools (task runs' messaging tools) */
export async function openMcpToolsSession(provider: McpToolsProvider): Promise<TaskToolsSession> {
  const port = await ensureServer();
  const token = randomBytes(24).toString('hex');
  sessions.set(token, provider);
  return {
    mcpServer: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } },
    close: () => {
      sessions.delete(token);
    },
  };
}

/**
 * Stop the server (app shutdown, tests)
 * @internal
 */
export function closeTaskToolsServer(): Promise<void> {
  sessions.clear();
  const current = server;
  server = null;
  listening = null;
  return new Promise((resolve) => (current ? current.close(() => resolve()) : resolve()));
}
