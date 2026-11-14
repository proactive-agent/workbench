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
      playwrightBrowser: {
        id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Me',
        executablePath: '/opt/google/chrome/chrome', userDataDir: '/c', profileDirectory: 'Default', profilePath: '/c/Default',
      },
    },
  }),
}));
vi.mock('../task-tools-server', () => ({ openChatToolsSession: async () => undefined }));
// A task elsewhere picked another profile: its copies are kept by the chat copy's sweep
const taskPick = { id: 'firefox:work', browser: 'firefox', engine: 'firefox', profileName: 'Work', executablePath: '/f', userDataDir: '/f', profilePath: '/f/work' };
vi.mock('../../browser-profiles/choices-in-use', () => ({
  browserChoicesInUse: async (_projectPath: string, settingsChoice: unknown) => ({ project: [settingsChoice], all: [settingsChoice, taskPick] }),
}));
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

    await executor.execute('p1', '/project', 'one', [], { mcpConnectors: ['playwright'] } as never);
    await executor.execute('p1', '/project', 'two', [], { mcpConnectors: ['playwright'] } as never);

    expect(prepareBrowserProfileCopy).toHaveBeenCalledTimes(2);
    // The profiles still chosen go with each copy, so its sweep keeps them
    expect(prepareBrowserProfileCopy.mock.calls[0][3]).toEqual(expect.objectContaining({ all: [expect.objectContaining({ id: 'chrome:Default' }), taskPick] }));
    const [first, second] = prepareBrowserProfileCopy.mock.calls.map((call) => call[2] as string);
    expect(first).toMatch(/^chat-/);
    expect(second).not.toBe(first);
    expect(removeBrowserProfileCopy.mock.calls.map((call) => call[0])).toEqual([`/copies/${first}`, `/copies/${second}`]);
    // The server reads the run's Playwright config from the copy, headless
    const args = runInsights.mock.calls[0][0].mcpServers.playwright.args as string[];
    expect(args.slice(-3)).toEqual(['--config', `/copies/${first}/.workbench-playwright.json`, '--headless']);
  });

  it("returns the reply without waiting for the copy's removal", async () => {
    runInsights.mockResolvedValue(result);
    // A browser still closing: the removal retries for a while
    removeBrowserProfileCopy.mockReturnValue(new Promise(() => undefined));
    const executor = new InsightsExecutor();

    const reply = await executor.execute('p1', '/project', 'one', [], { mcpConnectors: ['playwright'] } as never);

    expect(reply.fullResponse).toBe('ok');
    expect(removeBrowserProfileCopy).toHaveBeenCalledTimes(1);
  });

  it('removes the copy when the turn fails', async () => {
    runInsights.mockRejectedValue(new Error('boom'));
    const executor = new InsightsExecutor();
    executor.on('error', () => {});

    await expect(executor.execute('p1', '/project', 'one', [], { mcpConnectors: ['playwright'] } as never)).rejects.toThrow('boom');

    expect(removeBrowserProfileCopy).toHaveBeenCalledTimes(1);
  });

  it('runs Playwright with a profile in memory when the copy fails', async () => {
    runInsights.mockResolvedValue(result);
    prepareBrowserProfileCopy.mockRejectedValue(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    const executor = new InsightsExecutor();

    await executor.execute('p1', '/project', 'one', [], { mcpConnectors: ['playwright'] } as never);

    expect(runInsights.mock.calls[0][0].mcpServers.playwright.args).toContain('--isolated');
    expect(removeBrowserProfileCopy).not.toHaveBeenCalled();
  });
});
