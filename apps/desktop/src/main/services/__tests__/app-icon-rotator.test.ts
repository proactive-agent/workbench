import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppIconRotator, listRotationIcons } from '../app-icon-rotator';

let root: string;
let iconsDir: string;

function addIcons(...names: string[]): void {
  for (const name of names) writeFileSync(join(iconsDir, name), '');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'app-icon-rotator-'));
  iconsDir = join(root, 'app-icons');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('listRotationIcons', () => {
  it('returns numbered PNGs in numeric order and ignores other files', () => {
    mkdirSync(iconsDir);
    addIcons('10.png', '2.png', '1.png', 'notes.txt', 'icon.png', '3.jpg', '4.PNG');
    expect(listRotationIcons(iconsDir).map((p) => p.slice(iconsDir.length + 1))).toEqual([
      '1.png',
      '2.png',
      '4.PNG',
      '10.png',
    ]);
  });

  it('returns an empty list when the folder does not exist', () => {
    expect(listRotationIcons(join(root, 'missing'))).toEqual([]);
  });
});

describe('AppIconRotator', () => {
  it('creates the icons folder on start', () => {
    const rotator = new AppIconRotator({ iconsDir, applyIcon: () => true, restoreDefaultIcon: vi.fn() });
    rotator.start();
    rotator.stop();
    expect(existsSync(iconsDir)).toBe(true);
  });

  it('cycles through icons on each interval and wraps around', () => {
    vi.useFakeTimers();
    const applied: string[] = [];
    const rotator = new AppIconRotator({
      iconsDir,
      applyIcon: (p) => {
        applied.push(p.slice(iconsDir.length + 1));
        return true;
      },
      restoreDefaultIcon: vi.fn(),
      intervalMs: 10_000,
    });
    rotator.start();
    addIcons('1.png', '2.png', '3.png');

    vi.advanceTimersByTime(40_000);
    rotator.stop();
    expect(applied).toEqual(['1.png', '2.png', '3.png', '1.png']);
  });

  it('picks up icons added while running and restores the default when emptied', () => {
    const applied: string[] = [];
    const restoreDefaultIcon = vi.fn();
    const rotator = new AppIconRotator({
      iconsDir,
      applyIcon: (p) => {
        applied.push(p.slice(iconsDir.length + 1));
        return true;
      },
      restoreDefaultIcon,
    });
    rotator.start(); // empty folder: nothing applied, default kept
    rotator.stop();
    expect(applied).toEqual([]);
    expect(restoreDefaultIcon).not.toHaveBeenCalled();

    addIcons('1.png');
    rotator.tick();
    expect(applied).toEqual(['1.png']);

    unlinkSync(join(iconsDir, '1.png'));
    rotator.tick();
    expect(restoreDefaultIcon).toHaveBeenCalledTimes(1);
  });
});
