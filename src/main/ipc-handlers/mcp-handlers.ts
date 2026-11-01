/**
 * MCP Server Health Check Handlers
 *
 * Handles IPC requests for checking MCP server health and connectivity.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/ipc';
import type { CustomMcpServer, McpHealthCheckResult, McpHealthStatus, McpTestConnectionResult } from '../../shared/types/project';
import { spawn, type ChildProcess } from 'child_process';
import { appLog } from '../app-logger';
import { isWindows } from '../platform';
import { getWslInfo, whenShellRuntimeReady } from '../platform/shell-runtime';
import { killRuntimeProcess, spawnTool } from '../platform/runtime-exec';
import { findWslCommand, isCommandAvailable } from '../mcp-commands';
import { getToolEnvAsync } from '../cli-utils';
import { getMcpAvailability, onMcpAvailabilityChange } from '../mcp-availability';
import { detectBrowserProfiles } from '../browser-profiles/detect';
import { readSettingsFileAsync } from '../settings-utils';
import { getAllWindows } from '../window-manager';
import type { AppSettings } from '../../shared/types';

/** Why a command can't run in WSL, for the health check and the connection test */
function wslMissingMessage(command: string, windowsOnly: boolean): string {
  const distro = getWslInfo()?.distro ?? 'WSL';
  return windowsOnly
    ? `Command '${command}' is only installed on Windows; install it in WSL (${distro}), where the app runs its tools`
    : `Command '${command}' not found in WSL (${distro})`;
}

/**
 * Defense-in-depth: Frontend-side command validation
 * Mirrors the backend SAFE_COMMANDS allowlist to prevent arbitrary command execution
 * even if malicious configs somehow bypass backend validation
 */
const SAFE_COMMANDS = new Set(['npx', 'npm', 'node', 'python', 'python3', 'uv', 'uvx']);

/**
 * Defense-in-depth: Dangerous interpreter flags that allow code execution
 * Mirrors backend DANGEROUS_FLAGS to prevent args-based code injection
 */
const DANGEROUS_FLAGS = new Set([
  '--eval', '-e', '-c', '--exec',
  '-m', '-p', '--print',
  '--input-type=module', '--experimental-loader',
  '--require', '-r'
]);

/**
 * Defense-in-depth: Shell metacharacters that could enable command injection
 * when shell: true is used on Windows
 */
const SHELL_METACHARACTERS = ['&', '|', '>', '<', '^', '%', ';', '$', '`', '\n', '\r'];

/**
 * Validate that a command is in the safe allowlist
 */
function isCommandSafe(command: string | undefined): boolean {
  if (!command) return false;
  // Reject commands with paths (defense against path traversal)
  if (command.includes('/') || command.includes('\\')) return false;
  return SAFE_COMMANDS.has(command);
}

/**
 * Validate that args don't contain dangerous interpreter flags or shell metacharacters
 */
function areArgsSafe(args: string[] | undefined): boolean {
  if (!args || args.length === 0) return true;

  // Check for dangerous interpreter flags
  if (args.some(arg => DANGEROUS_FLAGS.has(arg))) return false;

  // On Windows with shell: true, check for shell metacharacters that could enable injection
  if (isWindows()) {
    if (args.some(arg => SHELL_METACHARACTERS.some(char => arg.includes(char)))) {
      return false;
    }
  }

  return true;
}

/**
 * Quick health check for a custom MCP server.
 * For HTTP servers: makes a HEAD/GET request to check connectivity.
 * For command servers: checks if the command exists.
 */
async function checkMcpHealth(server: CustomMcpServer): Promise<McpHealthCheckResult> {
  const startTime = Date.now();

  if (server.type === 'http') {
    return checkHttpHealth(server, startTime);
  } else {
    return checkCommandHealth(server, startTime);
  }
}

/**
 * Check HTTP server health by making a request.
 */
async function checkHttpHealth(server: CustomMcpServer, startTime: number): Promise<McpHealthCheckResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No URL configured',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Add custom headers if configured
    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    const response = await fetch(server.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    let status: McpHealthStatus;
    let message: string;

    if (response.ok) {
      status = 'healthy';
      message = 'Server is responding';
    } else if (response.status === 401 || response.status === 403) {
      status = 'needs_auth';
      message = response.status === 401 ? 'Authentication required' : 'Access forbidden';
    } else {
      status = 'unhealthy';
      message = `HTTP ${response.status}: ${response.statusText}`;
    }

    return {
      serverId: server.id,
      status,
      statusCode: response.status,
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Check for specific error types
    const status: McpHealthStatus = 'unhealthy';
    let message = errorMessage;

    if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
      message = 'Connection timed out';
    } else if (errorMessage.includes('ECONNREFUSED')) {
      message = 'Connection refused - server may be down';
    } else if (errorMessage.includes('ENOTFOUND')) {
      message = 'Server not found - check URL';
    }

    return {
      serverId: server.id,
      status,
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check command-based server health by verifying the command exists.
 */
async function checkCommandHealth(server: CustomMcpServer, startTime: number): Promise<McpHealthCheckResult> {
  if (!server.command) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No command configured',
      checkedAt: new Date().toISOString(),
    };
  }

  // Defense-in-depth: Validate command and args before spawn
  if (!isCommandSafe(server.command)) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: `Invalid command '${server.command}' - not in allowlist`,
      checkedAt: new Date().toISOString(),
    };
  }
  if (!areArgsSafe(server.args)) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'Args contain dangerous flags or shell metacharacters',
      checkedAt: new Date().toISOString(),
    };
  }

  // In WSL the server runs inside the distribution (Claude Code runs there), so look it up there
  await whenShellRuntimeReady();
  if (getWslInfo()) {
    const { path: found, windowsOnly } = await findWslCommand(server.command);
    return {
      serverId: server.id,
      status: found ? 'healthy' : 'unhealthy',
      message: found ? `Command '${server.command}' found in WSL` : wslMissingMessage(server.command, windowsOnly),
      responseTime: Date.now() - startTime,
      checkedAt: new Date().toISOString(),
    };
  }

  // Looked up with the PATH runs get (Node.js through version managers too), not the app's own,
  // which lacks the shell's PATH when the app was started from the desktop
  const found = await isCommandAvailable(server.command, { refresh: true });
  return {
    serverId: server.id,
    status: found ? 'healthy' : 'unhealthy',
    message: found ? `Command '${server.command}' found` : `Command '${server.command}' not found in PATH`,
    responseTime: Date.now() - startTime,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Full MCP connection test - actually connects to the server and tries to list tools.
 * This is more thorough but slower than the health check.
 */
async function testMcpConnection(server: CustomMcpServer): Promise<McpTestConnectionResult> {
  const startTime = Date.now();

  if (server.type === 'http') {
    return testHttpConnection(server, startTime);
  } else {
    return testCommandConnection(server, startTime);
  }
}

/**
 * Test HTTP MCP server connection by sending an MCP initialize request.
 */
async function testHttpConnection(server: CustomMcpServer, startTime: number): Promise<McpTestConnectionResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      success: false,
      message: 'No URL configured',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    // Send MCP initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'workbench-health-check',
          version: '1.0.0',
        },
      },
    };

    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(initRequest),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          serverId: server.id,
          success: false,
          message: 'Authentication failed',
          error: `HTTP ${response.status}: ${response.statusText}`,
          responseTime,
        };
      }
      return {
        serverId: server.id,
        success: false,
        message: `Server returned error`,
        error: `HTTP ${response.status}: ${response.statusText}`,
        responseTime,
      };
    }

    const data = await response.json();

    if (data.error) {
      return {
        serverId: server.id,
        success: false,
        message: 'MCP error',
        error: data.error.message || JSON.stringify(data.error),
        responseTime,
      };
    }

    // Now try to list tools
    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    const toolsResponse = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolsRequest),
    });

    let tools: string[] = [];
    if (toolsResponse.ok) {
      const toolsData = await toolsResponse.json();
      if (toolsData.result?.tools) {
        tools = toolsData.result.tools.map((t: { name: string }) => t.name);
      }
    }

    return {
      serverId: server.id,
      success: true,
      message: tools.length > 0 ? `Connected successfully, ${tools.length} tools available` : 'Connected successfully',
      tools,
      responseTime,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let message = 'Connection failed';
    if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
      message = 'Connection timed out';
    } else if (errorMessage.includes('ECONNREFUSED')) {
      message = 'Connection refused - server may be down';
    } else if (errorMessage.includes('ENOTFOUND')) {
      message = 'Server not found - check URL';
    }

    return {
      serverId: server.id,
      success: false,
      message,
      error: errorMessage,
      responseTime,
    };
  }
}

/**
 * Test command-based MCP server connection by spawning the process and trying to communicate.
 */
async function testCommandConnection(server: CustomMcpServer, startTime: number): Promise<McpTestConnectionResult> {
  if (!server.command) {
    return {
      serverId: server.id,
      success: false,
      message: 'No command configured',
    };
  }

  // Defense-in-depth: Validate command and args before spawn
  if (!isCommandSafe(server.command)) {
    return {
      serverId: server.id,
      success: false,
      message: `Invalid command '${server.command}' - not in allowlist`,
    };
  }
  if (!areArgsSafe(server.args)) {
    return {
      serverId: server.id,
      success: false,
      message: 'Args contain dangerous flags or shell metacharacters',
    };
  }

  // In WSL the server is started inside the distribution, as Claude Code there would start it
  await whenShellRuntimeReady();
  let wslCommand: string | null = null;
  if (getWslInfo()) {
    const { path: found, windowsOnly } = await findWslCommand(server.command);
    if (!found) {
      return {
        serverId: server.id,
        success: false,
        message: wslMissingMessage(server.command, windowsOnly),
        responseTime: Date.now() - startTime,
      };
    }
    wslCommand = found;
  }

  // The PATH runs get, so npx and node are found as Claude Code would find them
  const toolEnv = wslCommand ? undefined : await getToolEnvAsync();
  return new Promise((resolve) => {
    const args = server.args || [];

    // In WSL: through the runtime layer (Windows path arguments translated). On Windows, use
    // shell: true to properly handle .cmd/.bat scripts like npx
    const proc: ChildProcess = wslCommand
      ? spawnTool('python', args, { command: wslCommand, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(server.command!, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: toolEnv,
        timeout: 15000, // OS-level timeout for reliable process termination
        shell: isWindows(), // Required for Windows to run npx.cmd
      });
    // In WSL killing wsl.exe alone can leave the Linux process running
    const stop = () => (wslCommand ? killRuntimeProcess(proc) : proc.kill());

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        stop();
        const responseTime = Date.now() - startTime;
        resolve({
          serverId: server.id,
          success: false,
          message: 'Connection timed out',
          responseTime,
        });
      }
    }, 15000); // 15 second timeout (matches spawn timeout)

    // Send MCP initialize request
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'workbench-health-check',
          version: '1.0.0',
        },
      },
    }) + '\n';

    proc.stdin?.write(initRequest);

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');

      // Try to parse JSON response
      try {
        const lines = stdout.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const response = JSON.parse(line);
          if (response.id === 1 && response.result) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              stop();
              const responseTime = Date.now() - startTime;
              resolve({
                serverId: server.id,
                success: true,
                message: 'MCP server started successfully',
                responseTime,
              });
            }
            return;
          }
        }
      } catch {
        // Not valid JSON yet, keep waiting
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8');
    });

    proc.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const responseTime = Date.now() - startTime;
        resolve({
          serverId: server.id,
          success: false,
          message: 'Failed to start server',
          error: error.message,
          responseTime,
        });
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const responseTime = Date.now() - startTime;
        if (code === 0) {
          resolve({
            serverId: server.id,
            success: true,
            message: 'Server process started',
            responseTime,
          });
        } else {
          resolve({
            serverId: server.id,
            success: false,
            message: `Server exited with code ${code}`,
            error: stderr || undefined,
            responseTime,
          });
        }
      }
    });
  });
}

/**
 * Register MCP IPC handlers.
 */
export function registerMcpHandlers(): void {
  // Whether connectors' servers can start; unknown ones start being checked and each change is
  // sent to every window
  ipcMain.handle(IPC_CHANNELS.MCP_GET_AVAILABILITY, async (_event, ids: string[]) => {
    try {
      const settings = (await readSettingsFileAsync()) as Partial<AppSettings> | undefined;
      return { success: true, data: getMcpAvailability(Array.isArray(ids) ? ids : [], settings?.mcpConnectors) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Availability check failed' };
    }
  });
  onMcpAvailabilityChange((id, availability) => {
    for (const window of getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.MCP_AVAILABILITY_CHANGED, id, availability);
    }
  });

  // Browser profiles the Puppeteer connector can use (found at startup; `refresh` looks again)
  ipcMain.handle(IPC_CHANNELS.MCP_DETECT_BROWSER_PROFILES, async (_event, refresh?: boolean) => {
    try {
      return { success: true, data: await detectBrowserProfiles({ refresh: refresh === true }) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Browser detection failed' };
    }
  });

  // Quick health check
  ipcMain.handle(IPC_CHANNELS.MCP_CHECK_HEALTH, async (_event, server: CustomMcpServer) => {
    try {
      const result = await checkMcpHealth(server);
      return { success: true, data: result };
    } catch (error) {
      appLog.error('MCP health check error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Health check failed',
      };
    }
  });

  // Full connection test
  ipcMain.handle(IPC_CHANNELS.MCP_TEST_CONNECTION, async (_event, server: CustomMcpServer) => {
    try {
      const result = await testMcpConnection(server);
      return { success: true, data: result };
    } catch (error) {
      appLog.error('MCP connection test error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection test failed',
      };
    }
  });
}
