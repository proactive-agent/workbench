import { describe, it, expect, vi, beforeEach } from 'vitest';

const runInsights = vi.fn();
const prepareBrowserProfileCopy = vi.fn();
const removeBrowserProfileCopy = vi.fn();

vi.mock('../claude-code-runner', () => ({ runInsights: (...args: unknown[]) => runInsights(...args) }));
vi.mock('../../graphify', () => ({
  isGraphifyEnabled: async () => false,
  getGraphifyPromptContext: async () => null,
}));
vi.mock('../../cli-tool-manager', () => ({ getToolInfoAsync: async () => ({ found: false }) }));
vi.mock('../../mcp-availability', () => ({ usableMcpConnectorIds: (ids: string[]) => ids }));
vi.mock('../../project-store', () => ({ projectStore: { getProject: () => undefined } }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: async () => ({
    mcpConnectors: {
      puppeteerBrowser: {
        id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Me',
        executablePath: '/opt/google/chrome/chrome', userDataDir: '/c', profileDirectory: 'Default', profilePath: '/c/Default',
      },
    },
  }),
}));
vi.mock('../task-tools-server', () => ({ openTaskToolsSession: async () => undefined }));
vi.mock('../../browser-profiles/profile-copy', () => ({
  prepareBrowserProfileCopy: (...args: unknown[]) => prepareBrowserProfileCopy(...args),
  removeBrowserProfileCopy: (...args: unknown[]) => removeBrowserProfileCopy(...args),
}));

import { InsightsExecutor } from '../insights-executor';

const result = { text: 'ok', taskSuggestions: [] };

describe('chat browser profile copies', () => {
  beforeEach(() => {
    runInsights.mockReset();
    prepareBrowserProfileCopy.mockReset();
    removeBrowserProfileCopy.mockReset();
    prepareBrowserProfileCopy.mockImplementation(async (_project: string, _choice: unknown, slot: string) => `/copies/${slot}`);
  });

  it('copies the profile fresh for each turn and removes the copy when the turn ends', async () => {
    runInsights.mockResolvedValue(result);
    const executor = new InsightsExecutor();

    await executor.execute('p1', '/project', 'one', [], { mcpConnectors: ['puppeteer'] } as never);
    await executor.execute('p1', '/project', 'two', [], { mcpConnectors: ['puppeteer'] } as never);

    expect(prepareBrowserProfileCopy).toHaveBeenCalledTimes(2);
    const [first, second] = prepareBrowserProfileCopy.mock.calls.map((call) => call[2] as string);
    expect(first).toMatch(/^chat-/);
    expect(second).not.toBe(first);
    expect(removeBrowserProfileCopy.mock.calls.map((call) => call[0])).toEqual([`/copies/${first}`, `/copies/${second}`]);
    const env = runInsights.mock.calls[0][0].mcpServers.puppeteer.env.PUPPETEER_LAUNCH_OPTIONS as string;
    expect(env).toContain(`/copies/${first}`);
  });

  it("returns the reply without waiting for the copy's removal", async () => {
    runInsights.mockResolvedValue(result);
    // A browser still closing: the removal retries for a while
    removeBrowserProfileCopy.mockReturnValue(new Promise(() => undefined));
    const executor = new InsightsExecutor();

    const reply = await executor.execute('p1', '/project', 'one', [], { mcpConnectors: ['puppeteer'] } as never);

    expect(reply.fullResponse).toBe('ok');
    expect(removeBrowserProfileCopy).toHaveBeenCalledTimes(1);
  });

  it('removes the copy when the turn fails', async () => {
    runInsights.mockRejectedValue(new Error('boom'));
    const executor = new InsightsExecutor();
    executor.on('error', () => {});

    await expect(executor.execute('p1', '/project', 'one', [], { mcpConnectors: ['puppeteer'] } as never)).rejects.toThrow('boom');

    expect(removeBrowserProfileCopy).toHaveBeenCalledTimes(1);
  });

  it('runs Puppeteer with a new profile when the copy fails', async () => {
    runInsights.mockResolvedValue(result);
    prepareBrowserProfileCopy.mockRejectedValue(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    const executor = new InsightsExecutor();

    await executor.execute('p1', '/project', 'one', [], { mcpConnectors: ['puppeteer'] } as never);

    expect(runInsights.mock.calls[0][0].mcpServers.puppeteer).toBeDefined();
    expect(removeBrowserProfileCopy).not.toHaveBeenCalled();
  });
});
