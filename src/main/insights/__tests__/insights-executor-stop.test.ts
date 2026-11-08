import { describe, it, expect, vi, beforeEach } from 'vitest';

const runInsights = vi.fn();

vi.mock('../claude-code-runner', () => ({ runInsights: (...args: unknown[]) => runInsights(...args) }));
vi.mock('../../graphify', () => ({
  isGraphifyEnabled: async () => false,
  getGraphifyPromptContext: async () => null,
}));
// No real tool detection or MCP server checks (they start shells and servers)
vi.mock('../../cli-tool-manager', () => ({ getToolInfoAsync: async () => ({ found: false }) }));
vi.mock('../../mcp-availability', () => ({ usableMcpConnectorIds: (ids: string[]) => ids }));
vi.mock('../../project-store', () => ({ projectStore: { getProject: () => undefined } }));
vi.mock('../../settings-utils', () => ({ readSettingsFileAsync: async () => undefined }));
vi.mock('../task-tools-server', () => ({ openChatToolsSession: async () => undefined }));
vi.mock('../../rate-limit-detector', () => ({
  detectRateLimit: () => ({ isRateLimited: false }),
  createSDKRateLimitInfo: vi.fn(),
}));

import { InsightsExecutor } from '../insights-executor';

/** A run that streams `text`, then waits until its abort signal fires */
function streamUntilAborted(text: string) {
  runInsights.mockImplementationOnce(
    (config: { abortSignal: AbortSignal }, onStream: (event: unknown) => void) =>
      new Promise((_, reject) => {
        onStream({ type: 'text-delta', text });
        config.abortSignal.addEventListener('abort', () => {
          const error = new Error('Insights request was cancelled');
          error.name = 'AbortError';
          reject(error);
        });
      })
  );
}

describe('InsightsExecutor stop', () => {
  beforeEach(() => runInsights.mockReset());

  it('ends a stopped reply with what was written so far', async () => {
    const executor = new InsightsExecutor();
    const chunks: string[] = [];
    const phases: string[] = [];
    executor.on('stream-chunk', (_id, chunk) => chunks.push(chunk.type));
    executor.on('status', (_id, status) => phases.push(status.phase));
    streamUntilAborted('Partial answer');

    const run = executor.execute('p1', '/project', 'hi', []);
    await vi.waitFor(() => expect(executor.isSessionActive('p1')).toBe(true));
    await vi.waitFor(() => expect(chunks).toContain('text'));

    expect(executor.cancelSession('p1')).toBe(true);
    const result = await run;

    expect(result.fullResponse).toBe('Partial answer');
    expect(result.stopped).toBe(true);
    expect(chunks.at(-1)).toBe('done');
    expect(phases.at(-1)).toBe('complete');
    expect(executor.isSessionActive('p1')).toBe(false);
  });

  it('counts as replying while the agent window opens, and Stop ends the wait without a turn', async () => {
    const executor = new InsightsExecutor();
    const phases: string[] = [];
    executor.on('status', (_id, status) => phases.push(status.phase));
    const opening = new Promise(() => undefined);

    const run = executor.execute('p1', '/project', 'hi', [], undefined, undefined, { chatSessionId: 'c1', beforeRun: () => opening });
    await vi.waitFor(() => expect(executor.isSessionActive('p1', 'c1')).toBe(true));
    expect(executor.cancelSession('p1', 'c1')).toBe(true);
    const result = await run;

    expect(result.stopped).toBe(true);
    expect(runInsights).not.toHaveBeenCalled();
    expect(phases.at(-1)).toBe('complete');
    expect(executor.isSessionActive('p1', 'c1')).toBe(false);
  });

  it('reports nothing to stop when no reply is running', () => {
    expect(new InsightsExecutor().cancelSession('p1')).toBe(false);
  });

  it('leaves the chat to a newer message that replaced the run', async () => {
    const executor = new InsightsExecutor();
    const chunks: string[] = [];
    executor.on('stream-chunk', (_id, chunk) => chunks.push(chunk.type));
    streamUntilAborted('First');
    streamUntilAborted('Second');

    const first = executor.execute('p1', '/project', 'one', []);
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    const second = executor.execute('p1', '/project', 'two', []);
    const replaced = await first;
    expect(replaced.replaced).toBe(true);
    expect(replaced.stopped).toBe(false);

    // The replaced run sent no 'done', and the newer run is still the active one
    expect(chunks).not.toContain('done');
    await vi.waitFor(() => expect(chunks).toHaveLength(2));
    expect(executor.isSessionActive('p1')).toBe(true);

    executor.cancelSession('p1');
    await second;
    expect(chunks.at(-1)).toBe('done');
  });
});
