/**
 * Mock implementation for Claude profile management operations
 */

export const claudeProfileMock = {
  getClaudeProfiles: async () => ({
    success: true,
    data: {
      profiles: [],
      activeProfileId: 'default'
    }
  }),

  saveClaudeProfile: async (profile: { id: string; name: string; oauthToken?: string; email?: string; isDefault?: boolean; createdAt?: Date }) => ({
    success: true,
    data: {
      id: profile.id,
      name: profile.name,
      oauthToken: profile.oauthToken,
      email: profile.email,
      isDefault: profile.isDefault ?? false,
      createdAt: profile.createdAt ?? new Date(),
    }
  }),

  deleteClaudeProfile: async () => ({ success: true }),
  loginClaudeAccount: async () => ({ success: true }),
  redetectClaudeAccounts: async () => ({ success: true, data: { profiles: [], activeProfileId: '' } }),

  renameClaudeProfile: async () => ({ success: true }),

  setActiveClaudeProfile: async () => ({ success: true }),

  switchClaudeProfile: async () => ({ success: true }),

  initializeClaudeProfile: async () => ({ success: true }),

  setClaudeProfileToken: async () => ({ success: true }),

  fetchClaudeUsage: async () => ({ success: true }),


  onAuthFailure: () => () => {},

  retryWithProfile: async () => ({ success: true }),

  // Usage Monitoring
  requestUsageUpdate: async () => ({
    success: true,
    data: null
  }),

  requestAllProfilesUsage: async (_forceRefresh?: boolean) => ({
    success: true,
    data: null
  }),

  onUsageUpdated: () => () => {},

  onAllProfilesUsageUpdated: () => () => {},

  // Returns terminal config for embedded authentication
  authenticateClaudeProfile: async (profileId: string) => ({
    success: true,
    data: { terminalId: `claude-login-${profileId}-${Date.now()}`, configDir: '/mock/config' }
  }),

  verifyClaudeProfileAuth: async (_profileId: string) => ({
    success: true,
    data: { authenticated: false, email: undefined }
  }),

  claudeAuthLoginSubprocess: async () => ({ success: true, data: { authenticated: false } }),
  cancelClaudeAuthLogin: async () => ({ success: true }),
  onClaudeAuthLoginProgress: () => () => {},
};
