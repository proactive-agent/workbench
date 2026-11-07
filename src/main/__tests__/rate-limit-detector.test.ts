/**
 * Unit tests for rate limit and auth failure detection
 * Tests detection patterns for rate limiting and authentication failures
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the claude-profile-manager before importing
vi.mock('../claude-profile-manager', () => ({
  getClaudeProfileManager: vi.fn(() => ({
    getActiveProfile: vi.fn(() => ({
      id: 'test-profile-id',
      name: 'Test Profile',
      isDefault: true
    })),
    getProfile: vi.fn((id: string) => ({
      id,
      name: 'Test Profile',
      isDefault: true
    })),
    recordRateLimitEvent: vi.fn()
  }))
}));

describe('Rate Limit Detector', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('detectRateLimit', () => {
    it('should detect rate limit with reset time', async () => {
      const { detectRateLimit } = await import('../rate-limit-detector');

      const output = 'Limit reached · resets Dec 17 at 6am (Europe/Oslo)';
      const result = detectRateLimit(output);

      expect(result.isRateLimited).toBe(true);
      expect(result.resetTime).toBe('Dec 17 at 6am (Europe/Oslo)');
      expect(result.limitType).toBe('weekly');
    });

    it('should detect rate limit with bullet character', async () => {
      const { detectRateLimit } = await import('../rate-limit-detector');

      const output = 'Limit reached • resets 11:59pm';
      const result = detectRateLimit(output);

      expect(result.isRateLimited).toBe(true);
      expect(result.resetTime).toBe('11:59pm');
      expect(result.limitType).toBe('session');
    });

    it('should detect secondary rate limit indicators', async () => {
      const { detectRateLimit } = await import('../rate-limit-detector');

      const testCases = [
        'rate limit exceeded',
        'usage limit reached',
        'You have exceeded your limit',
        'too many requests'
      ];

      for (const output of testCases) {
        const result = detectRateLimit(output);
        expect(result.isRateLimited).toBe(true);
      }
    });

    it('should return false for non-rate-limit output', async () => {
      const { detectRateLimit } = await import('../rate-limit-detector');

      const output = 'Task completed successfully';
      const result = detectRateLimit(output);

      expect(result.isRateLimited).toBe(false);
    });

    it('should return false for empty output', async () => {
      const { detectRateLimit } = await import('../rate-limit-detector');

      const result = detectRateLimit('');

      expect(result.isRateLimited).toBe(false);
    });
  });

});

describe('Auth Failure Detection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('auth failure does not match rate limit patterns', () => {
    it('should not detect auth failure as rate limit', async () => {
      const { detectRateLimit } = await import('../rate-limit-detector');

      const authErrors = [
        '[CLI] authentication required',
        '[Auth] not authenticated',
        'Error: unauthorized',
        'Error: invalid token',
        'Please obtain a new token - session expired',
        '· Please run /login'
      ];

      for (const error of authErrors) {
        const result = detectRateLimit(error);
        expect(result.isRateLimited).toBe(false);
      }
    });

  });

});

describe('Billing Failure Detection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('cross-detection tests', () => {

    it('should not detect billing errors as rate limits', async () => {
      const { detectRateLimit } = await import('../rate-limit-detector');

      const billingMessages = [
        'credit balance is too low',
        'insufficient credits',
        'billing error',
        'extra_usage exceeded',
      ];

      for (const msg of billingMessages) {
        const result = detectRateLimit(msg);
        expect(result.isRateLimited).toBe(false);
      }
    });
  });

});

describe('ensureCleanProfileEnv', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('with CLAUDE_CONFIG_DIR set', () => {
    it('should preserve CLAUDE_CONFIG_DIR while clearing CLAUDE_CODE_OAUTH_TOKEN', async () => {
      const { ensureCleanProfileEnv } = await import('../rate-limit-detector');

      const env = {
        CLAUDE_CONFIG_DIR: '/tmp/profile-1',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-123',
        ANTHROPIC_API_KEY: 'sk-ant-key-456'
      };
      const result = ensureCleanProfileEnv(env);

      expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/profile-1');
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
      expect(result.ANTHROPIC_API_KEY).toBe('');
    });

    it('should preserve other environment variables', async () => {
      const { ensureCleanProfileEnv } = await import('../rate-limit-detector');

      const env = {
        CLAUDE_CONFIG_DIR: '/tmp/profile-1',
        CLAUDE_CODE_OAUTH_TOKEN: 'token',
        ANTHROPIC_API_KEY: 'key',
        SOME_OTHER_VAR: 'value'
      };
      const result = ensureCleanProfileEnv(env);

      expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/profile-1');
      expect(result.SOME_OTHER_VAR).toBe('value');
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
      expect(result.ANTHROPIC_API_KEY).toBe('');
    });

    it('should clear tokens even if they are not present in input', async () => {
      const { ensureCleanProfileEnv } = await import('../rate-limit-detector');

      const env = {
        CLAUDE_CONFIG_DIR: '/tmp/profile-1'
      };
      const result = ensureCleanProfileEnv(env);

      expect(result.CLAUDE_CONFIG_DIR).toBe('/tmp/profile-1');
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
      expect(result.ANTHROPIC_API_KEY).toBe('');
    });
  });

  describe('without CLAUDE_CONFIG_DIR', () => {
    it('should return env unchanged when CLAUDE_CONFIG_DIR is not set', async () => {
      const { ensureCleanProfileEnv } = await import('../rate-limit-detector');

      const env = {
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-123',
        ANTHROPIC_API_KEY: 'sk-ant-key-456'
      };
      const result = ensureCleanProfileEnv(env);

      expect(result).toEqual(env);
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token-123');
      expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-key-456');
    });
  });

  describe('edge cases', () => {
    it('should handle empty profile env', async () => {
      const { ensureCleanProfileEnv } = await import('../rate-limit-detector');

      const result = ensureCleanProfileEnv({});

      // Empty env has no CLAUDE_CONFIG_DIR, so should return as-is
      expect(result).toEqual({});
    });

    it('should handle env with empty string CLAUDE_CONFIG_DIR', async () => {
      const { ensureCleanProfileEnv } = await import('../rate-limit-detector');

      const env = {
        CLAUDE_CONFIG_DIR: '',
        CLAUDE_CODE_OAUTH_TOKEN: 'token'
      };
      const result = ensureCleanProfileEnv(env);

      // Empty string is falsy, so should not trigger clearing
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('token');
    });

    it('should return a new object when clearing (not mutate input)', async () => {
      const { ensureCleanProfileEnv } = await import('../rate-limit-detector');

      const env = {
        CLAUDE_CONFIG_DIR: '/tmp/profile-1',
        CLAUDE_CODE_OAUTH_TOKEN: 'token'
      };
      const result = ensureCleanProfileEnv(env);

      // Original should not be mutated
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token');
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
      expect(result).not.toBe(env);
    });
  });
});
