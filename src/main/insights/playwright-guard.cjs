// Workbench's guard for the Claude chat's Playwright server (stdio MCP, between Claude Code and it)
//
// The chat can't change the project's files, but Playwright's MCP server writes files a tool call
// names (`filename`) under its workspace root, which is the first root its client (Claude Code)
// reports: the project. So the guard starts the server in the folder it is given (argv[2], the
// turn's own folder) and leaves `roots` out of the client's capabilities, so the server's root is
// that folder (Playwright falls back to its working folder without roots): named files, uploads
// and file:// pages stay inside it. `browser_run_code_unsafe` (Node.js code in the server, with
// file access) is left out of the tool list and refused. The rest of the command line (argv[3..])
// is the server's command. Plain Node, no packages; run by Workbench's own executable as Node
// (ELECTRON_RUN_AS_NODE=1), or by the distribution's node in WSL.
//
// With a chat browser (WORKBENCH_CHAT_BROWSER_URL and _TOKEN set: the server attaches to the
// chat's own browser, held by Workbench), every tool call first asks Workbench to open that
// browser when it isn't open (the `open_chat_browser` tool of the turn's token on Workbench's
// local tools server), and waits for it. Messages keep their order meanwhile. `browser_close` is
// refused there: the browser is the chat's, shared with the user, and stays open (closing the
// attached context could take the browser down).
'use strict';
const { spawn } = require('child_process');

const [workspace, command, ...args] = process.argv.slice(2);
const BLOCKED_TOOLS = new Set(['browser_run_code_unsafe']);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const chatBrowser = env.WORKBENCH_CHAT_BROWSER_URL && env.WORKBENCH_CHAT_BROWSER_TOKEN
  ? { url: env.WORKBENCH_CHAT_BROWSER_URL, token: env.WORKBENCH_CHAT_BROWSER_TOKEN }
  : null;
delete env.WORKBENCH_CHAT_BROWSER_URL;
delete env.WORKBENCH_CHAT_BROWSER_TOKEN;

/** A cmd.exe argument (npx is npx.cmd on Windows, started through the shell) */
function cmdArg(arg) {
  return /^[\w:\\/.@=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

const child = process.platform === 'win32'
  ? spawn([command, ...args].map(cmdArg).join(' '), { cwd: workspace, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] })
  : spawn(command, args, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'inherit'] });

/** Call `onLine` with each newline-delimited message of a stream */
function readLines(stream, onLine) {
  let buffer = '';
  stream.on('data', (data) => {
    buffer += data.toString('utf-8');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) onLine(line);
    }
  });
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** An error result for a tool call, sent back to Claude Code without reaching the server */
function refuse(id, text) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } }) + '\n');
}

/** Ask Workbench to open the chat's browser (when it isn't open); resolves with an error text or null */
async function openChatBrowser() {
  try {
    const response = await fetch(chatBrowser.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${chatBrowser.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open_chat_browser', arguments: {} } }),
    });
    const answer = await response.json();
    if (answer && answer.result && !answer.result.isError) return null;
    const text = answer && answer.result && Array.isArray(answer.result.content)
      ? answer.result.content.map((part) => part.text || '').join(' ')
      : answer && answer.error && answer.error.message;
    return `The browser could not be opened: ${text || `HTTP ${response.status}`}`;
  } catch (error) {
    return `The browser could not be opened: ${error && error.message ? error.message : error}`;
  }
}

// Claude Code -> server, one message at a time (a tool call may wait for the chat's browser)
let inbound = Promise.resolve();
readLines(process.stdin, (line) => {
  inbound = inbound.then(() => forward(line)).catch(() => undefined);
});

async function forward(line) {
  const message = parse(line);
  if (message && message.method === 'initialize' && message.params && message.params.capabilities) {
    delete message.params.capabilities.roots;
    child.stdin.write(JSON.stringify(message) + '\n');
    return;
  }
  // Without the roots capability there are no roots to change
  if (message && message.method === 'notifications/roots/list_changed') return;
  if (message && message.method === 'tools/call' && BLOCKED_TOOLS.has(message.params && message.params.name)) {
    refuse(message.id, 'This tool is not available in this chat');
    return;
  }
  if (message && message.method === 'tools/call' && chatBrowser && message.params && message.params.name === 'browser_close') {
    refuse(message.id, "This chat's browser stays open: the user works in it too. To close a tab, use browser_tabs with action close");
    return;
  }
  if (message && message.method === 'tools/call' && chatBrowser) {
    const failure = await openChatBrowser();
    if (failure) {
      refuse(message.id, failure);
      return;
    }
  }
  child.stdin.write(line + '\n');
}
process.stdin.on('end', () => {
  inbound.then(() => child.stdin.end());
});

// Server -> Claude Code: the tool list without the blocked tools
readLines(child.stdout, (line) => {
  const message = parse(line);
  if (message && message.result && Array.isArray(message.result.tools)) {
    message.result.tools = message.result.tools.filter((tool) => !BLOCKED_TOOLS.has(tool && tool.name));
    process.stdout.write(JSON.stringify(message) + '\n');
    return;
  }
  process.stdout.write(line + '\n');
});

child.stdin.on('error', () => undefined);
child.on('error', (error) => {
  process.stderr.write(`Could not start the Playwright server: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
