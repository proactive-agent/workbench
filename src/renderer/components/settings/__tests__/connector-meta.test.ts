import { describe, it, expect } from 'vitest';
import { isChromeNotDownloaded } from '../connector-meta';

describe('isChromeNotDownloaded', () => {
  it("is true only for the command that downloads Puppeteer's Chrome", () => {
    expect(isChromeNotDownloaded('npx puppeteer browsers install chrome@131.0.6778.204')).toBe(true);
    expect(isChromeNotDownloaded('npx puppeteer browsers install chrome')).toBe(true);
    expect(isChromeNotDownloaded('npx puppeteer browsers install firefox')).toBe(false);
    expect(isChromeNotDownloaded(undefined)).toBe(false);
    expect(isChromeNotDownloaded('')).toBe(false);
  });
});
