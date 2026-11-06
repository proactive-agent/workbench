import { describe, expect, it } from 'vitest';
import {
  getDefaultMcpConnectorIds,
  getUsableCustomServers,
  migrateMcpConnectorSettings,
  migrateTaskConnectorFields,
  normalizeMcpConnectorIds,
} from '../mcp-connectors';

const chrome = {
  id: 'chrome:Default', browser: 'chrome', engine: 'chromium', profileName: 'Me',
  executablePath: '/opt/google/chrome/chrome', userDataDir: '/home/me/.config/google-chrome', profilePath: '/home/me/.config/google-chrome/Default',
};
const oldManagedFirefox = {
  id: 'puppeteer:firefox', browser: 'firefox', engine: 'firefox', managed: true, profileName: 'Firefox',
  executablePath: '/home/me/.cache/puppeteer/firefox/linux-133.0/firefox/firefox', userDataDir: '', profilePath: '',
};

describe('mcp connectors', () => {
  it('defaults to Context7 on, browser automation off', () => {
    expect(getDefaultMcpConnectorIds(undefined)).toEqual(['context7']);
  });

  it('includes only tested custom servers that are switched on', () => {
    const settings = {
      context7Enabled: false,
      electronEnabled: true,
      customServers: [
        { id: 'on', name: 'On', type: 'command' as const, command: 'npx', verified: true },
        { id: 'off', name: 'Off', type: 'command' as const, command: 'npx', verified: true, enabled: false },
        { id: 'untested', name: 'Untested', type: 'command' as const, command: 'npx' },
      ],
    };
    expect(getDefaultMcpConnectorIds(settings)).toEqual(['electron', 'on']);
    expect(getUsableCustomServers(settings).map((s) => s.id)).toEqual(['on', 'off']);
  });

  describe('data saved before the browser connector moved to Playwright', () => {
    it('renames the old connector id, keeping each id once', () => {
      expect(normalizeMcpConnectorIds(['context7', 'puppeteer', 'custom-1'])).toEqual(['context7', 'playwright', 'custom-1']);
      expect(normalizeMcpConnectorIds(['puppeteer', 'playwright'])).toEqual(['playwright']);
      // Ids that only look like an object's own properties stay as they are
      expect(normalizeMcpConnectorIds(['constructor', 'toString', '__proto__'])).toEqual(['constructor', 'toString', '__proto__']);
      // A custom server the user added under the old name keeps its id
      expect(normalizeMcpConnectorIds(['puppeteer', 'context7'], ['puppeteer'])).toEqual(['puppeteer', 'context7']);
    });

    it("moves custom servers off a built-in connector's id", () => {
      const server = (id: string) => ({ id, name: id, type: 'command', command: 'npx', verified: true });
      const settings: Record<string, unknown> = {
        mcpConnectors: { customServers: [server('playwright'), server('playwright-custom'), server('context7'), server('mine')] },
      };
      expect(migrateMcpConnectorSettings(settings)).toBe(true);
      expect((settings.mcpConnectors as { customServers: Array<{ id: string }> }).customServers.map((s) => s.id))
        .toEqual(['playwright-custom-2', 'playwright-custom', 'context7-custom', 'mine']);
      expect(migrateMcpConnectorSettings(settings)).toBe(false);
    });

    it("keeps a task's id of a custom server named like the old connector", () => {
      const metadata: Record<string, unknown> = { mcpConnectors: ['puppeteer'] };
      expect(migrateTaskConnectorFields(metadata, ['puppeteer'])).toBe(false);
      expect(metadata.mcpConnectors).toEqual(['puppeteer']);
    });

    it('renames the settings file connector keys and the old managed Firefox choice', () => {
      const settings: Record<string, unknown> = { mcpConnectors: { context7Enabled: true, puppeteerEnabled: true, puppeteerBrowser: oldManagedFirefox } };
      expect(migrateMcpConnectorSettings(settings)).toBe(true);
      expect(settings.mcpConnectors).toEqual({
        context7Enabled: true,
        playwrightEnabled: true,
        playwrightBrowser: { ...oldManagedFirefox, id: 'playwright:firefox' },
      });
      expect(getDefaultMcpConnectorIds(settings.mcpConnectors as never)).toEqual(['context7', 'playwright']);
      // Already current: nothing to do
      expect(migrateMcpConnectorSettings(settings)).toBe(false);
      expect(migrateMcpConnectorSettings(undefined)).toBe(false);
      expect(migrateMcpConnectorSettings({})).toBe(false);
    });

    it('keeps the new settings when both old and new keys are there', () => {
      const settings: Record<string, unknown> = { mcpConnectors: { puppeteerEnabled: true, playwrightEnabled: false, puppeteerBrowser: chrome } };
      migrateMcpConnectorSettings(settings);
      expect(settings.mcpConnectors).toEqual({ playwrightEnabled: false, playwrightBrowser: chrome });
    });

    it("renames a task's connector ids and browser pick, including Playwright's own Chromium (null)", () => {
      const metadata: Record<string, unknown> = { mcpConnectors: ['puppeteer', 'context7'], puppeteerBrowser: chrome, title: 'x' };
      expect(migrateTaskConnectorFields(metadata)).toBe(true);
      expect(metadata).toEqual({ mcpConnectors: ['playwright', 'context7'], playwrightBrowser: chrome, title: 'x' });
      expect(migrateTaskConnectorFields(metadata)).toBe(false);

      const ownChromium: Record<string, unknown> = { puppeteerBrowser: null };
      expect(migrateTaskConnectorFields(ownChromium)).toBe(true);
      expect(ownChromium).toEqual({ playwrightBrowser: null });

      const managed: Record<string, unknown> = { puppeteerBrowser: oldManagedFirefox };
      migrateTaskConnectorFields(managed);
      expect((managed.playwrightBrowser as { id: string }).id).toBe('playwright:firefox');
      expect(migrateTaskConnectorFields(null)).toBe(false);
    });
  });
});
