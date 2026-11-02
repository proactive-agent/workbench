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
'use strict';
const { spawn } = require('child_process');

const [workspace, command, ...args] = process.argv.slice(2);
const BLOCKED_TOOLS = new Set(['browser_run_code_unsafe']);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

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

// Claude Code -> server
readLines(process.stdin, (line) => {
  const message = parse(line);
  if (message && message.method === 'initialize' && message.params && message.params.capabilities) {
    delete message.params.capabilities.roots;
    child.stdin.write(JSON.stringify(message) + '\n');
    return;
  }
  // Without the roots capability there are no roots to change
  if (message && message.method === 'notifications/roots/list_changed') return;
  if (message && message.method === 'tools/call' && BLOCKED_TOOLS.has(message.params && message.params.name)) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { isError: true, content: [{ type: 'text', text: 'This tool is not available in this chat' }] },
    }) + '\n');
    return;
  }
  child.stdin.write(line + '\n');
});
process.stdin.on('end', () => child.stdin.end());

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
