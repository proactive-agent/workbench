import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false, getPath: () => '/tmp' },
  net: { request: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), logger: null },
}));

vi.mock('../settings-utils', () => ({
  readSettingsFile: () => ({ ...store.settings }),
  writeSettingsFile: (settings: Record<string, unknown>) => {
    store.settings = { ...settings };
  },
}));

import { shouldSuppressUpdate, skipUpdateVersion, snoozeUpdate } from '../app-updater';

describe('update notification suppression', () => {
  beforeEach(() => {
    store.settings = {};
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not suppress anything by default', () => {
    expect(shouldSuppressUpdate('2.9.0')).toBe(false);
  });

  it('suppresses only the skipped version', () => {
    skipUpdateVersion('2.9.0');

    expect(shouldSuppressUpdate('2.9.0')).toBe(true);
    expect(shouldSuppressUpdate('2.9.1')).toBe(false);
  });

  it('suppresses all versions until a snooze expires', () => {
    snoozeUpdate();

    expect(shouldSuppressUpdate('2.9.0')).toBe(true);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(shouldSuppressUpdate('2.9.0')).toBe(false);
  });

  it('clears an active snooze when a version is skipped', () => {
    snoozeUpdate();
    skipUpdateVersion('2.9.0');

    expect(store.settings.updateRemindAfter).toBeUndefined();
    expect(shouldSuppressUpdate('2.9.1')).toBe(false);
  });
});
