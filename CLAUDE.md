# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Product Overview

Auto Claude is a TypeScript Electron desktop app where users describe a goal and AI agents autonomously handle planning,
implementation, and QA validation. All work happens in isolated git worktrees so the main branch stays safe.

**Core workflow:** User creates a task → Spec creation pipeline assesses complexity and writes a specification → Planner
agent breaks it into subtasks → Coder agent implements (can spawn parallel subagents) → QA reviewer validates → QA fixer
resolves issues → User reviews and merges.

**Main features:**

- **Autonomous Tasks** — Multi-agent pipeline (planner, coder, QA) that builds features end-to-end
- **Kanban Board** — Visual task management from planning through completion
- **Agent Terminals** — Up to 12 parallel AI-powered terminals with task context injection
- **Insights** — AI chat interface for exploring and understanding a codebase
- **Roadmap** — AI-assisted feature planning
- **Ideation** — Discover improvements, performance issues, and security vulnerabilities
- **GitHub/GitLab Integration** — Import issues, AI-powered investigation, PR/MR review and creation
- **Changelog** — Generate release notes from completed tasks
- **Memory** — Local knowledge store that retains insights across sessions
- **Isolated Workspaces** — Git worktree isolation for every build; AI-powered semantic merge
- **Flexible Authentication** — Claude Code subscription (OAuth) or API profiles with any Anthropic-compatible endpoint
- **Multi-Account Swapping** — When one Claude account hits a rate limit, switch to an available one automatically
- **Cross-Platform** — Windows, macOS, and Linux with auto-updates

## Critical Rules

**Vercel AI SDK only** — All AI interactions use the Vercel AI SDK v6 (`ai` package) via the agent layer in
`src/main/ai/`. NEVER use `@anthropic-ai/sdk` or `anthropic.Anthropic()` directly. Use `createProvider()` from
`src/main/ai/providers/factory.ts` and `streamText()`/`generateText()` from the `ai` package.

**i18n required** — All user-facing text uses `react-i18next` translation keys (see [i18n](#i18n)).

**Platform abstraction** — Never use `process.platform` directly. Import from `src/main/platform/` (see
[Cross-Platform](#cross-platform)).

**No console.log in production code** — `console.log` output is invisible in bundled Electron apps. Use Sentry for error
tracking in production; reserve `console.log` for development only.

**No time estimates** — Provide priority-based ordering instead of duration predictions.

**PR target** — Always target the `develop` branch for PRs, not `main`. Main is reserved for releases.

## Work Approach: Orchestrator-First

You are an orchestrator. Your primary role is to understand what needs to be done, break it into workstreams, and
delegate execution to agent teams. This keeps your context window focused on coordination and decision-making rather
than filling up with implementation details.

<orchestrator_pattern>
When given a task, follow this pattern:

1. **Investigate first** — Read the actual code before forming any hypothesis. Use targeted searches (Glob, Grep, Read)
   for simple lookups. For broader exploration, spawn an Explore agent.

2. **Plan the approach** — Identify what needs to change, which files are involved, and whether work can be
   parallelized. For multi-step tasks, create a task list to track workstreams.

3. **Delegate execution** — Spawn agent teams to do the implementation work. Each agent gets a clear, self-contained
   assignment with all the context it needs: relevant file paths, the specific change to make, and acceptance criteria.
   Run independent workstreams in parallel.

4. **Verify and integrate** — Review agent outputs, run tests, and ensure changes work together. Fix integration issues
   or spawn follow-up agents as needed.
</orchestrator_pattern>

**When to delegate vs. do directly:**

- Delegate: multi-file changes, research across the codebase, independent parallel workstreams, tasks that would consume
  significant context
- Do directly: single-file edits, simple bug fixes, quick lookups, tasks where you already have the context

**Giving agents good assignments** — Each agent works with a fresh context. Include: the specific goal, relevant file
paths, code patterns to follow, and what "done" looks like.

**Minimal changes only** — Prefer the simplest approach (e.g., prompt-only changes, single guard clause) before
suggesting multi-component solutions. If the user asks for X, implement X — don't bundle additional fixes they didn't
request.

**Default to action** — When the user's intent implies making changes, implement them rather than only suggesting. If
something is unclear, read the relevant code to fill in the gaps rather than asking. Only ask when genuine ambiguity
remains about what the user wants.

## Commands

```bash
npm install            # Install dependencies (postinstall rebuilds native modules for Electron)
npm run dev            # Development mode with HMR
npm run dev:debug      # Development mode with verbose debug output
npm run dev:mcp        # Development mode with remote debugging on port 9222 (Electron MCP)
npm start              # Production build + run
npm run typecheck      # TypeScript type check (strict)
npm test               # Unit + integration tests (Vitest)
npm run test:e2e       # End-to-end tests (Playwright)
```

### Packaging

| Command                 | Output                                  |
|-------------------------|-----------------------------------------|
| `npm run package`       | Package for the current platform        |
| `npm run package:mac`   | macOS `.dmg` + `.zip`                   |
| `npm run package:win`   | Windows `.exe` (NSIS installer)         |
| `npm run package:linux` | Linux `.deb` (check with `npm run verify:linux`) |

Packages are written to `dist/`.

### Releases

```bash
node .github/scripts/bump-version.js patch|minor|major  # Bump version, then open a PR to main
```

Merging to `main` runs `prepare-release.yml`, which tags the version and triggers `release.yml`. Beta releases run
manually via `beta-release.yml`.

## Project Structure

```
auto-claude/
├── src/
│   ├── main/                # Electron main process
│   │   ├── ai/              # AI agent layer (Vercel AI SDK v6)
│   │   │   ├── providers/       # Provider registry + factory
│   │   │   ├── session/         # streamText() agent loop, error classification, progress
│   │   │   ├── agent/           # Worker thread executor + bridge
│   │   │   ├── orchestration/   # Build pipeline (planner → coder → QA)
│   │   │   ├── tools/           # Builtin tools
│   │   │   ├── security/        # Bash validator, command parser, path containment
│   │   │   ├── config/          # Agent configs, phase config, model resolution
│   │   │   ├── prompts/         # Prompt loading and assembly
│   │   │   ├── runners/         # Insights, roadmap, ideation, PR review, etc.
│   │   │   ├── memory/          # Local memory store (libSQL)
│   │   │   ├── mcp/             # MCP client integration
│   │   │   └── auth/            # Token resolution (reuses claude-profile/)
│   │   ├── agent/           # Agent queue, process, state, events
│   │   ├── claude-profile/  # Multi-profile credentials, token refresh, usage
│   │   ├── terminal/        # PTY daemon, lifecycle, CLI integration
│   │   ├── platform/        # Cross-platform abstraction
│   │   ├── ipc-handlers/    # IPC handler modules by domain
│   │   └── services/        # App services (session recovery, rate-limit resume, header icon rotation, PR status)
│   ├── preload/             # Preload scripts (electronAPI bridge)
│   ├── renderer/            # React UI (components, stores, contexts, hooks, styles)
│   └── shared/              # Shared types, i18n, constants, utils
├── prompts/                 # Agent system prompts (.md)
├── resources/               # App icons, macOS entitlements, bundled header icons
├── e2e/                     # Playwright end-to-end tests
└── .github/                 # Workflows and scripts (postinstall, prebuilds, deb check, bump-version)
```

## AI Agent Layer (`src/main/ai/`)

- **Providers** (`providers/`) — `createProviderRegistry()` supports Anthropic, OpenAI, Google, Bedrock, Azure, Mistral,
  Groq, xAI, OpenRouter, Z.AI, and Ollama. Transforms handle thinking-token normalization and prompt caching.
- **Session runtime** (`session/`) — `runAgentSession()` uses `streamText()` with `stopWhen: stepCountIs(N)` for
  tool-use loops, with error classification (429/401/400) and progress tracking.
- **Worker threads** (`agent/`) — Sessions run in `worker_threads` so the main process stays responsive; `WorkerBridge`
  relays `postMessage()` events to `AgentManagerEvents`.
- **Build orchestration** (`orchestration/`) — Planner → coder → QA pipeline with parallel subagents.
- **Tools** (`tools/builtin/`) — Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, and SpawnSubagent, defined
  with Zod schemas via AI SDK `tool()`.
- **Config** (`config/`) — `AGENT_CONFIGS` registry, phase-aware model resolution, thinking budgets.

```typescript
import { streamText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

// Agent session
const result = streamText({
  model: provider,
  system: systemPrompt,
  messages: conversationHistory,
  tools: toolRegistry.getToolsForAgent(agentType),
  stopWhen: stepCountIs(1000),
  onStepFinish: ({ toolCalls, text }) => progressTracker.update(toolCalls, text),
});

// Tool definition
const readTool = tool({
  description: 'Read a file from the filesystem',
  inputSchema: z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
  execute: async ({ file_path, offset, limit }) => { /* ... */ },
});
```

### Agent Prompts (`prompts/`)

| Prompt                                                | Purpose                                         |
|-------------------------------------------------------|-------------------------------------------------|
| `spec_gatherer/researcher/writer/critic.md`           | Spec creation pipeline                          |
| `spec_quick.md`, `spec_orchestrator_agentic.md`       | Quick spec / agentic spec orchestration         |
| `complexity_assessor.md`                              | Complexity assessment                           |
| `planner.md`, `coder.md`                              | Implementation plan / subtask implementation    |
| `qa_reviewer.md`, `qa_fixer.md`                       | Acceptance validation / issue fixes             |
| `roadmap_*.md`, `ideation_*.md`                       | Roadmap and ideation runners                    |
| `github/pr_*_agent.md`, `github/pr_finding_validator.md` | Parallel PR review specialists and validator |
| `mcp_tools/*.md`                                      | Tool guidance injected for MCP-enabled projects |

In dev, prompts load from `prompts/`; packaged builds load them from `process.resourcesPath/prompts` (extraResources).

### Spec Directory

Each spec in `.auto-claude/specs/XXX-name/` contains `spec.md`, `requirements.json`, `context.json`,
`implementation_plan.json`, `qa_report.md`, and `QA_FIX_REQUEST.md`, plus runtime files such as `task_metadata.json`,
`task_logs.json`, and `build-progress.txt`.

### Electron MCP (agent QA of the app)

Run `npm run dev:mcp` and enable the Electron MCP server for the project (`ELECTRON_MCP_ENABLED=true`). QA agents then
drive the running app over the Chrome DevTools Protocol with `get_electron_window_info`, `take_screenshot`, `send_command_to_electron`, and `read_electron_logs`.

## Frontend

**Stack:** Electron 40, React 19, TypeScript (strict), Vercel AI SDK v6, Zustand 5, Tailwind CSS v4, Radix UI,
xterm.js 6, electron-vite 5 (Vite 7), Vitest 4 + React Testing Library + jsdom, Playwright, Motion.

**Path aliases:** `@/*` → `src/renderer/*`, `@shared/*` → `src/shared/*`, `@preload/*` → `src/preload/*`.

**State (Zustand)** — Renderer stores live in `src/renderer/stores/` (`project-store.ts`, `task-store.ts`,
`terminal-store.ts`, `settings-store.ts`, `insights-store.ts`, `roadmap-store.ts`, `kanban-settings-store.ts`,
`github/issues-store.ts`, `github/pr-review-store.ts`). Main-process stores: `src/main/project-store.ts`,
`src/main/terminal-session-store.ts`.

**Styling** — Tailwind CSS v4 via `@tailwindcss/postcss`; `clsx` + `tailwind-merge` through `cn()`; variants with
`class-variance-authority`. Two color themes, **Default** and **Lime** (`src/shared/constants/themes.ts`), each with
light/dark variants via CSS custom properties in `src/renderer/styles/globals.css`.

**IPC** — Handlers in `src/main/ipc-handlers/` (by domain), safe APIs exposed in `src/preload/`, renderer calls
`window.electronAPI.*`.

**Agent management** (`src/main/agent/`) — `agent-queue.ts` (routing, prioritization, spec number locking),
`agent-process.ts` (spawns workers via `WorkerBridge`), `agent-state.ts`, `agent-events.ts`.

**Claude profiles** (`src/main/claude-profile/`) — `credential-utils.ts` (OS keychain), `token-refresh.ts` (OAuth
refresh), `usage-monitor.ts` (usage and rate limits), `profile-scorer.ts` (profile selection).

**Terminals** (`src/main/terminal/`) — `pty-daemon.ts` / `pty-manager.ts` (PTY processes), `terminal-lifecycle.ts`,
`cli-integration-handler.ts`. Renderer uses xterm.js 6 with WebGL, fit, web-links, and serialize addons.

## i18n

English is the only supported language. Translation files: `src/shared/i18n/locales/en/*.json`.

**Namespaces:** `common`, `navigation`, `settings`, `dialogs`, `tasks`, `taskReview`, `terminal`, `errors`,
`onboarding`, `welcome`, `gitlab`.

```tsx
import { useTranslation } from 'react-i18next';

const { t } = useTranslation(['navigation', 'common']);

<span>{t('navigation:items.githubPRs')}</span>       // CORRECT
<span>GitHub PRs</span>                               // WRONG
<span>{t('errors:task.parseError', { error })}</span> // With interpolation
```

## Cross-Platform

Supports Windows, macOS, and Linux; CI runs tests on all three. Use `src/main/platform/`:

| Function                                  | Purpose                           |
|-------------------------------------------|-----------------------------------|
| `isWindows()` / `isMacOS()` / `isLinux()` | OS detection                      |
| `getPathDelimiter()`                      | `;` (Win) or `:` (Unix)           |
| `findExecutable(name)`                    | Cross-platform executable lookup  |
| `requiresShell(command)`                  | `.cmd/.bat` shell detection (Win) |
| `joinPaths(...parts)`                     | Platform-correct path joining     |

## Known Gotchas

**Electron path resolution** — Paths often differ between dev and packaged builds (`app.isPackaged`,
`process.resourcesPath`). In dev, `__dirname` is `out/main`; in production, bundled assets live under
`process.resourcesPath`. Verify both contexts.

**Resetting PR review state** — To make PR reviews run fresh, in the project's `.auto-claude/github/`:

1. `rm pr/logs_*.json` — review logs
2. `rm pr/review_*.json` — review results
3. Reset `pr/index.json` to `{"reviews": [], "last_updated": null}`
4. Reset `bot_detection_state.json` to `{"reviewed_commits": {}}` — without this, the bot detector skips already-seen
   commits
