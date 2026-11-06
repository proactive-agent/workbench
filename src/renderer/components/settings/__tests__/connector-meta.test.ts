import { describe, it, expect } from 'vitest';
import { isChromiumNotDownloaded } from '../connector-meta';

describe('isChromiumNotDownloaded', () => {
  it("is true only for the command that downloads Playwright's Chromium", () => {
    expect(isChromiumNotDownloaded('npx -y @playwright/mcp@0.0.83 install-browser chromium')).toBe(true);
    expect(isChromiumNotDownloaded('npx -y @playwright/mcp@0.0.83 install-browser firefox')).toBe(false);
    expect(isChromiumNotDownloaded('npx -y @playwright/mcp@0.0.83 install-browser webkit')).toBe(false);
    expect(isChromiumNotDownloaded(undefined)).toBe(false);
    expect(isChromiumNotDownloaded('')).toBe(false);
  });
});
