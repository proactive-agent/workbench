import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';

// Load .env file for build-time constants (embedded API keys)
dotenvConfig({ path: resolve(__dirname, '.env') });

/**
 * Build-time constants embedded via Vite `define`.
 *
 * In CI builds, these come from GitHub secrets.
 * In local development, these come from .env (loaded by dotenv).
 *
 * The `define` option replaces these values at build time, so they're
 * embedded in the bundle and available at runtime in packaged apps.
 */
/** Embedded API keys — search works out of the box, no user config needed. */
const embeddedKeys = {
  '__SERPER_API_KEY__': JSON.stringify(process.env.SERPER_API_KEY || ''),
};

export default defineConfig({
  main: {
    define: embeddedKeys,
    plugins: [externalizeDepsPlugin({
      // Bundle these packages into the main process (they won't be in node_modules in packaged app)
      exclude: [
        'uuid',
        'chokidar',
        'dotenv',
        'electron-log',
        'proper-lockfile',
        'semver',
        'zod',
        '@anthropic-ai/sdk',
        'kuzu',
        'electron-updater',
        '@electron-toolkit/utils',
        // debug -> ms (used by bundled dependencies)
        'debug',
        'ms',
        // Minimatch for glob pattern matching in worktree handlers
        'minimatch',
        // XState for task state machine
        'xstate',
        // Vercel AI SDK packages (needed by worker thread + main process)
        'ai',
        '@ai-sdk/anthropic',
        '@ai-sdk/openai',
        '@ai-sdk/google',
        '@ai-sdk/amazon-bedrock',
        '@ai-sdk/azure',
        '@ai-sdk/mistral',
        '@ai-sdk/groq',
        '@ai-sdk/xai',
        '@ai-sdk/openai-compatible',
        '@ai-sdk/provider',
        '@ai-sdk/provider-utils',
        // Additional packages bundled into the main process (historically required
        // when npm workspaces hoisted them out of the packaged node_modules)
        '@ai-sdk/mcp',
        '@modelcontextprotocol/sdk',
        '@openrouter/ai-sdk-provider',
        '@tavily/core',
      ]
    })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Worker thread entry point — must be a separate chunk so it can be
          // spawned via `new Worker(path)` from WorkerBridge
          'ai/agent/worker': resolve(__dirname, 'src/main/ai/agent/worker.ts'),
        },
        // Native modules that must remain external (loaded from disk, not bundled).
        // @libsql/client is loaded lazily via globalThis.require() and resolved
        // from extraResources/node_modules via Module.globalPaths (see index.ts).
        external: ['@lydell/node-pty']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@features': resolve(__dirname, 'src/renderer/features'),
        '@components': resolve(__dirname, 'src/renderer/shared/components'),
        '@hooks': resolve(__dirname, 'src/renderer/shared/hooks'),
        '@lib': resolve(__dirname, 'src/renderer/shared/lib')
      }
    },
    server: {
      watch: {
        // Ignore directories to prevent HMR conflicts during merge operations
        // Using absolute paths and broader patterns
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.worktrees/**',
          '**/.auto-claude/**',
          '**/out/**',
          // Ignore the parent autonomous-coding directory's worktrees
          resolve(__dirname, '../.worktrees/**'),
          resolve(__dirname, '../.auto-claude/**'),
        ]
      }
    }
  }
});
