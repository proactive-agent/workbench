/**
 * Mock implementation for environment configuration operations
 */

export const integrationMock = {
  // Environment Configuration Operations
  getProjectEnv: async () => ({
    success: true,
    data: {
      memoryEnabled: false,
      enableFancyUi: true
    }
  }),

  updateProjectEnv: async () => ({
    success: true
  })
};
