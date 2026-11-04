# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Product Overview

Workbench is a TypeScript Electron desktop app where users describe a goal and the **Claude Code CLI** does the work
autonomously. Every task runs in its own git worktree so the main branch stays safe. Beyond running tasks, it brings
together what Claude Code and the tools around it already offer and sets each piece up for a project with a switch
(project memory, a Graphify graph of the code, MCP connectors, the live agent graph), adding what is missing between
them (messaging between parallel tasks), so sessions do better work for less without hand-written configuration.

**Core workflow:** User creates a task (description, images, connectors, git options) → a short Claude Code **triage**
run picks model, effort and whether to plan → Claude Code **plans** (plan mode, optional) → **implements** in the task's
worktree (same session, permission checks off) → **validates** (project checks + fresh-context review + commit) → user
reviews, requests changes (same session continues) or merges.

**Main features:**

- **Autonomous Tasks** — Each task is delegated to Claude Code (`claude -p`) in its worktree; Claude Code decides
  when to use subagents, skills, MCP tools and its task list
- **Kanban Board** — Visual task management from planning through completion; the Queue column starts tasks as
  slots free up (Maximum parallel tasks, `src/main/services/task-queue.ts`)
- **Agent windows** — Parallel Claude Code terminals on the Agents page (12 by default, up to 24) with task context
  injection; each window runs its own session (`claude --session-id`, recorded in `.workbench/agent-sessions.json`)
- **Claude chat** — The Claude page (code: `src/main/insights/`): chats about the project, each a persistent Claude
  Code session that can't change the project's files; with the Kanban button on it also manages the project's tasks
  (see [Claude chat](#claude-chat))
- **Pull Requests** — Create a GitHub pull request from a task's worktree and merge it (via the `gh` CLI). A task with
  an open PR stays in Human Review (PR Created); Merge PR (`src/main/ai/runners/github/pr-merger.ts`) pulls the target
  branch into the task branch, lets the merge agent (`src/main/ai/runners/merge-agent.ts`, Claude Code) resolve
  conflicts, checks that no line the target added was lost, pushes and merges the PR, then moves the task to Done
- **Connectors** — MCP servers added to a task's Claude Code session (`--mcp-config`: Context7, Electron, Playwright,
  user-added servers) with app-wide defaults in Settings and per-task choices in the task dialog; a server stays
  disabled until it can start. Playwright's browsers run headless; Claude chats' browsers show in the browser drawer
  inside Workbench, task runs' stay unseen
- **Graphify memory graph** — Optional [Graphify](https://github.com/Graphify-Labs/graphify) knowledge graph of a
  project's code, built into `.workbench/knowledge` and offered to agents
- **Self-improve** — Optional project memory: Claude Code's auto memory kept in `.workbench/compeng` and shared by
  every session in the project (see [Self-improve](#self-improve-project-memory))
- **Live agent graph** — Optional live graph of a project's Claude Code sessions next to each agent window
- **Isolated Workspaces** — Git worktree isolation for every build; AI-powered semantic merge
- **Authentication** — Claude subscription accounts (each a `CLAUDE_CONFIG_DIR`) or API profiles with any
  Anthropic-compatible endpoint
- **Multi-Account Swapping** — When one Claude account hits a rate limit, switch to an available one automatically
- **Cross-Platform** — Windows, macOS, and Linux with in-app updates (Settings > Updates)

## Critical Rules

**Claude Code CLI only** — All AI work (tasks, triage, Claude chat, titles, PR text, commit messages, merge conflict
help) runs through the locally installed Claude Code CLI via `src/main/claude-code/`. Use `ClaudeTaskRun` for tasks and
`runClaudeText()` for one-shot calls; never call the Anthropic API or an AI SDK directly for these.

**i18n required** — All user-facing text uses `react-i18next` translation keys (see [i18n](#i18n)).

**Platform abstraction** — Never use `process.platform` directly. Import from `src/main/platform/` (see
[Cross-Platform](#cross-platform)).

**No console.log in production code** — `console.log` output is invisible in bundled Electron apps. Log errors in the
main process with `appLog` (`src/main/app-logger.ts`, written to the logs folder); reserve `console.log` for development
only.

**No time estimates** — Provide priority-based ordering instead of duration predictions.

**PR target** — Always target the `main` branch for PRs; it is the only long-lived branch.

**Never block the main process** — IPC handlers reachable from the UI must not run synchronous child processes
(`execFileSync`/`execSync`) or network calls; use async `execFile` (promisified). A sync `git fetch` used to freeze the
whole app every time a dialog opened.

**Don't re-fetch on open** — Pages and dialogs show stored values (Zustand stores, settings, or
`src/renderer/lib/refresh-cache.ts` for results of slow checks) and only fetch when the user presses a refresh
button, or once when nothing was fetched before. Shared hook: `useProjectBranches()` (it lists local refs
again in the background, never `git fetch`, so branches made outside the app show up).

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
npm install            # Install dependencies (postinstall rebuilds native modules; on Linux it also fixes chrome-sandbox)
npm run dev            # Development mode with HMR and remote debugging on port 9222 (Electron MCP)
npm run build          # Production build (electron-vite, into out/)
npm test               # Type check (strict) + all tests (Vitest)
npm run lint           # knip: fixes unused exports and types, then reports unused production code
```

**Versioning** — The version in `package.json` follows the git history: the `.husky/post-commit` hook runs
`.github/scripts/sync-version.cjs` and amends the new version into the commit (a patch per commit, a minor per pull
request merged into main; the major is set by hand). `WORKBENCH_SKIP_VERSION_BUMP=1` skips it.

### Packaging

| Command                 | Output                                           |
|-------------------------|--------------------------------------------------|
| `npm run package:mac`   | macOS `.dmg` + `.zip`                            |
| `npm run package:win`   | Windows `.exe` (NSIS installer)                  |
| `npm run package:linux` | Linux `.deb`                                     |

Packages are written to `dist/`.

### Releases

Releases are created by hand on GitHub, never by a workflow. Publishing a release runs `release.yml`; publishing a
pre-release runs `beta-release.yml`. Each one builds the four platforms in a matrix (`npm ci`, `npm run build`,
`npm run package:*`), takes the version from the release tag (the beta workflow adds `-beta` when the tag has no
pre-release suffix) and uploads the installers and update manifests to that release with `gh release upload`.

Builds are unsigned and not notarized: the repo holds no signing secrets. The release repository is public, so the
updater reads releases unauthenticated and the build needs no token.

### App updates

`src/main/app-updater.ts` checks GitHub Releases 3 seconds after launch, then every 4 hours in packaged builds.
`src/main/updater/release-selection.ts` offers the highest eligible version (stable releases, plus pre-releases with
Beta updates on); electron-updater only downloads and installs that release, when the user asks on Settings > Updates.
A new version opens Settings > Updates when Auto-update projects (`autoUpdateAutoBuild`) is on, otherwise a desktop
notification does. There is no update modal.

## Project Structure

```
workbench/
├── src/
│   ├── main/                # Electron main process
│   │   ├── claude-code/     # Claude Code CLI integration (task runner, triage, one-shot calls, session costs)
│   │   ├── ai/              # Remaining helpers: runners (PR, commit, merge help), merge/
│   │   ├── worktree/        # Task worktree creation
│   │   ├── insights/        # Claude chat (the Claude page) through Claude Code, task tools server
│   │   ├── agent/           # AgentManager: starts/stops Claude Code task runs, relays events
│   │   ├── task-messaging/  # Parallel tasks message each other, Workbench notices, merge sync
│   │   ├── task-resync/     # Out-of-date tasks take in a merged branch
│   │   ├── self-improve/    # Project memory (Claude Code auto memory in .workbench/compeng)
│   │   ├── live-agent/      # Live agent graph: hooks setup and relay worker
│   │   ├── browser-drawer/  # Browser drawer: Playwright's registry, the browser bridge
│   │   ├── updater/         # Release selection for app updates
│   │   ├── claude-profile/  # Multi-profile credentials, token refresh, usage
│   │   ├── terminal/        # PTY processes, lifecycle, CLI integration, session menu
│   │   ├── platform/        # Cross-platform abstraction
│   │   ├── ipc-handlers/    # IPC handler modules by domain
│   │   └── services/        # App services (task queue, rate-limit resume, profile service)
│   ├── preload/             # Preload scripts (electronAPI bridge)
│   ├── renderer/            # React UI (components, stores, contexts, hooks, styles)
│   └── shared/              # Shared types, i18n, constants, utils
├── resources/               # App and tray icons, macOS entitlements
├── .husky/                  # post-commit hook (version from the git history)
└── .github/                 # Workflows, the postinstall and version scripts
```

## Claude Code Layer (`src/main/claude-code/`)

- **Task runner** (`task-runner.ts`, `ClaudeTaskRun`) — runs one task in its worktree:
  - `triage` (`triage.ts`): read-only `claude -p --json-schema` run → `TaskTriage` (model `haiku|sonnet|opus|fable`,
    effort `low…max`, needsPlan, scope, title, verification commands). Rules follow Claude Code's model-config and
    best-practices docs; Settings > Agents (`claudeCodeTasks`) can fix model/effort, force planning on/off, turn off
    validation or allow Fable.
  - `plan`: `--permission-mode plan` + structured plan (headless plan mode has no `ExitPlanMode`), saved to `plan.md`.
  - `implement`: resumes the same session (`--resume`) with `--dangerously-skip-permissions` (worktree isolation;
    without a worktree it uses `--permission-mode auto`) and the triage model/effort.
  - `validate`: same session runs checks, reviews the diff with fresh eyes (`/code-review` or a subagent), commits,
    returns a structured `ValidationReport`. `revise` mode applies "request changes" feedback, then validates again.
  - Workflows (`workflows.ts`): when triage sizes a task `large`, validation asks for a Claude Code workflow that
    reviews the diff from several angles and has each finding checked before it counts, and implementation may use
    one for many-file changes. Settings > Agents > Limits sets `workflowSizeGuideline` (passed with `--settings`) and
    `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, or turns workflows off. Launches are recorded in
    `ClaudeRunInfo.workflows`, so a step continued after a stop or usage limit relaunches its run with
    `resumeFromRunId` (finished agents reuse their results; a profile swap copies the session's directory with them).
  - State in `<specDir>/claude_run.json` (`ClaudeRunInfo`: session id, triage, plan, phases with cost, `system/init`
    info, subagents, validation) so stopped / rate-limited runs continue; logs in `task_logs.json`. Claude Code's
    task list (TaskCreate/TaskUpdate, enabled with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`) is mirrored as the task's subtasks.
- **One-shot calls** (`run-text.ts`, `runClaudeText`) — `claude -p --output-format json --no-session-persistence`, tools
  off unless asked, optional `--json-schema`.
- **Process + env** (`process.ts`, `env.ts`) — async spawn, stream-json parsing (`stream-types.ts`), best available
  Claude profile (rate-limit aware) or the active API profile.
- **Session costs** (`project-sessions.ts`, `session-spending.ts`, `session-pricing.ts`) — a project's other Claude
  Code sessions (agent windows, Claude chat, `claude` in a terminal), found by the directory they ran in, and what they
  cost per day from their transcripts (Metrics, `src/main/project-metrics.ts`).
- **Session entrypoint** (`session-entrypoint.ts`) — tells headless sessions (`sdk-*`: task runs, chats, one-shot
  calls) from interactive ones, so agent windows' Session menu and the Live agent graph leave headless ones out.
- **AgentManager** (`src/main/agent/agent-manager.ts`) — creates the worktree, builds the run config (attachments,
  connectors, Graphify, settings) and relays run events (`log`, `execution-progress`, `task-event`, `run-info`,
  `subtasks`, `run-finished`) to the IPC layer and the XState task machine.

Claude Code docs: https://code.claude.com/docs/en/ (CLI reference, headless mode, sub-agents, model config,
permission modes, worktrees, hooks, skills).

### Task Directory

Each task's `.workbench/tasks/XXX-name/` contains `task_metadata.json`, `implementation_plan.json` (status and
mirrored task list), `claude_run.json`, `task_logs.json`, `plan.md` (when planned) and `attachments/`; also
`task_inbox.json` (messages waiting for the task), `resync_request.json` and `previous_runs/<nnn>/` (the runs a task
was started over from, `src/main/task-run-archive.ts`). Worktrees live in `.workbench/worktrees/tasks/`.

### Task Changelog (parallel tasks)

Task hooks (`src/main/task-hooks.ts`, `taskHooks.on('state' | 'files-edited', ...)`) run on every state a task
enters (state machine transitions and manual moves) and on the files its Claude Code session edits (Edit, Write,
MultiEdit, NotebookEdit tool calls). `src/main/task-changelog-writer.ts` turns them into the project's
`.workbench/changelog.jsonl` (one JSON entry per line; state entries carry every file the task's branch changes).
At every phase, `buildParallelTasksPrompt()` (`src/main/task-changelog.ts`) adds a "Parallel tasks" section to the
task's system prompt: the other tasks with unmerged changes and the files they touch. Tasks edit whatever files they
need (git merges changes to different parts of a file by itself); the prompt asks them to skip churn in shared files
and to agree via `message_task` when both need the same lines.

### Task messaging and resync

With Task messaging on (Settings > Agents, `claudeCodeTasks.taskMessaging`, on by default), task runs get Workbench's
`message_task` and `list_parallel_tasks` tools (`src/main/task-messaging/`, served by the task tools server with a
token per run) and `[Workbench]` notices (`notices.ts`: a task started, finished or was merged, two tasks' changes
conflict). After a task edits a file another task changes, `conflict-check.ts` test-merges both tasks' work
(uncommitted edits snapshotted with a temp index, `git merge-tree --write-tree`) and names the conflicting files and
lines; when that can't run, sharing the file is announced instead. The broker (`broker.ts`) writes a message to a live
run's stdin or keeps it in the target's `task_inbox.json` for its next phase. With Messages from your Claude sessions on
(`claudeCodeTasks.sessionMessages`, on by default), task runs also accept Claude Code's built-in SendMessage from the
user's other sessions (`--settings {"crossSessionInbound":"accept"}`): agent windows are told the task session names
(`task-messaging/window-hint.ts`), and the Claude chat gets `message_task` (through the broker) plus ListAgents /
SendMessage with the Kanban button. When a task is merged, the other tasks based on that branch go back to In
Progress to take it in (`task-messaging/merge-sync.ts` → `src/main/task-resync/`), also while messaging is off.

### MCP Connectors

Settings > Connectors (`settings.mcpConnectors`, `McpConnectorSettings`) holds the defaults: Context7, Electron and
Playwright, plus custom servers, which must pass a connection test before they can be switched on. New tasks copy the
enabled ids into `TaskMetadata.mcpConnectors` and can change them in the task dialog. When a task runs,
`buildMcpConfig()` (`src/main/claude-code/mcp-config.ts`) turns that task's ids into `--mcp-config` for its Claude Code
session, on top of the user's own Claude Code MCP configuration. Helpers live in `src/shared/utils/mcp-connectors.ts`.
Data saved before the browser connector moved from Puppeteer to Playwright (id `puppeteer`, `puppeteerEnabled`,
`puppeteerBrowser`) is renamed where it is read (`migrate*` helpers there: the settings file in `settings-utils.ts`,
task metadata in the project store, drafts, chats), so nothing else knows the old names.

Playwright is Microsoft's `@playwright/mcp`, pinned (`PLAYWRIGHT_MCP_PACKAGE` in `browser-profiles/managed.ts`, with the
browser builds that version needs, `PLAYWRIGHT_BUILDS`: bump them together). Its row picks a browser profile
(`McpConnectorSettings.playwrightBrowser`): `src/main/browser-profiles/` finds Chrome, Edge, Brave, Chromium and
Firefox profiles (`Local State`, `profiles.ini`) once at startup, and each run gets a copy of the chosen profile in the
app's data folder, `<userData>/browser-profiles/<project>/<profile>/<slot>` (in WSL
`~/.cache/workbench/browser-profiles` in the distro; snap Chromium, which runs confined, in its own
`~/snap/chromium/common/workbench-profiles`; never inside the project, where Claude sessions could read its
cookies; Chrome 136+ refuses remote debugging on its default data dir). Each copy names its Workbench process
(`.workbench-copy-owner.json`, its time refreshed while in use), so sweeps never remove another running Workbench's
copies. Each copy also holds the run's Playwright config (`.workbench-playwright.json`, `playwrightProfileConfig()`),
passed with `--config`: Chromium browsers run their executable on the copy with `--profile-directory`, the sandbox on
and without Playwright's `--password-store=basic` / `--use-mock-keychain` (so copied sign-ins decrypt); the user's
Firefox runs over WebDriver BiDi (channel `moz-firefox`, which Playwright calls experimental; Playwright's plain
`firefox` is its own patched build) with Sync prefs off. Without a copy (Playwright's own browsers, the availability
check, a failed copy) the server gets `--browser` / `--executable-path` and `--isolated` (a profile in memory;
Playwright's own Chromium also `--sandbox`, which Playwright leaves off on Linux). Runs
pass `--output-dir` to their temporary folder, since Playwright otherwise saves snapshots and screenshots in the
session's working folder (`.playwright-mcp` in the worktree). The task dialog's Playwright row picks a profile for
that task (`TaskMetadata.playwrightBrowser`, null for Playwright's own Chromium; unset follows Settings), which its runs
use instead; sweeps keep the copies of every profile Settings or a task still chooses
(`browser-profiles/choices-in-use.ts`). Why that server and not chrome-devtools-mcp is noted at the top of
`mcp-config.ts`. The default is Playwright's own Chromium (Chrome for Testing, `--browser chromium`, never the
installed Chrome); the picker also lists Playwright's Firefox and WebKit (`managed.ts`, found in Playwright's cache
`ms-playwright/<name>-<revision>` once `INSTALLATION_COMPLETE` is there) as disabled items with a download button
that opens a terminal running `npx -y @playwright/mcp@<version> install-browser <name>` (`MCP_INSTALL_BROWSER`; the
main process picks the command, then watches the cache, sends the new list and checks the connector again). Safari is
listed but can't be used; WebKit is the closest engine. Microsoft Store Firefox is found by the profiles its package keeps
(`%LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming\Mozilla\Firefox`) and run through its app execution alias's target
(`app-alias.ts`). Profiles a browser never opened (no activity files) are left out after a week.

In WSL mode Windows profiles work without anything installed on Windows (`detect.ts`): a Windows Firefox profile is
copied into the distribution and run by a Firefox there (an installed one at least the profile's version, else
Playwright's with `--allow-downgrade`), keeping its sign-ins. A Windows Chromium browser (Edge, Chrome) runs on Windows
through `browser-profiles/windows-browser-launcher.cjs`, the server's command run by the distribution's node: it starts
the browser through interop on a copy kept on Windows (headless, `--no-startup-window`, Edge's Alt+Tab tabs off with
`--disable-features=msWindowTabManagerPublic`, no `--force-device-scale-factor`, which leaves the drawer's screencast
without frames), relays a local port to its
DevTools port through `windows-cdp-relay.cjs` (Workbench's executable as Node, on Windows) and starts Playwright with
`--cdp-endpoint`; the relay's `--keep` mode closes the browser and removes a temporary profile when the launcher goes,
even when it is killed. Those profiles are marked "Saved sign-ins don't carry over": Chrome and Edge encrypt cookies
with an app-bound key that only opens in the browser's own profile folder, never in a copy.

`src/main/mcp-availability.ts` starts each connector's server once where Claude Code runs, as a run would, until it
answers `initialize` (Playwright is also asked to open `about:blank` with `browser_navigate`, headless, since it needs
a browser; a missing build of Playwright's own browser offers its install-browser command; `mcp-commands.ts` finds the
command, and the built-in servers need npx from Node.js). Until a server is ready, its switch is off and disabled on
the Connectors page, in the task dialog and in the chat's MCP menu, and runs leave out unavailable servers. An
unavailable result is checked again when asked for after 30 seconds. Runs copy the chosen browser profile, and an
open browser keeps it locked and half written (`browser-profiles/in-use.ts` reads its lock), so each profile also has
one saved copy, made in the background whenever the browser is found closed: a run that starts while the browser is
open copies the saved one instead. Only an open browser with no saved copy yet makes Playwright unavailable; the
switch's tooltip asks to close it once, and closing it enables the connector within a few seconds. A task's own
browser is probed for its runs apart from the windows' result (`checkRunServer`). Custom servers never take a
built-in's id (moved to `<id>-custom` when the settings are read).

Runs' browsers are headless (`--headless` on every Playwright server's command line, also over a profile copy's config),
so no browser window opens. Task runs' browsers stay that way, unseen; Claude chats' browsers are watched and driven in
the **browser drawer** at the main window's right edge (`src/main/browser-drawer/`, `components/browser-drawer/`,
`browser-drawer-store.ts`), Workbench's own UI: a tab per page of the project's chat browsers (a + button opens a new tab in the shown tab's browser), a toolbar (back, forward,
reload, address), the live page below. The drawer is on the Claude page only and shows only the chat's own browser (below);
closed, the chat opens it again from a button in its top-right corner (with a dot while the chat's browser is open), and
other pages have no drawer or handle (the browsers keep running). Its width is resizable (up to half the window) and
remembered; each chat keeps its own view (open or closed, the tab shown).
@playwright/mcp binds every browser it launches into Playwright's machine-wide registry (`<cache>/ms-playwright/b`, one
JSON file per browser: title = the MCP client's name, workspace folder, socket, its playwright-core), which
`registry.ts` reads every 2 seconds (live = its socket answers; browsers the bridge is connected to aren't asked, its link
reports when they go). Only chats' browsers belong to a project (`project-match.ts`): a chat browser's holder works in
its own temp folder, registered for its project while it runs (with WSL interop off, a chat's server works in the turn's temp folder,
registered while the turn runs). A task run's browser (its workspace is the task's worktree or the project) matches no
project, so no window lists it and the bridge never connects to it. A session the drawer shows that starts opens the drawer on its page. Once a drawer
opens, the browser bridge runs until quit (`browser-bridge.cjs`, started by `bridge-process.ts` with Workbench's
executable as Node; messages over its stdin/stdout as JSON headers with raw bytes for frames, `bridge-framing.ts`): it
connects to the projects' browsers with each one's own playwright-core
(`require(playwrightLib)` from the npx cache: nothing of Playwright ships with the app, the client always matches the
server; disconnecting leaves the browser running) and reports their pages, each given Workbench's theme as its
`prefers-color-scheme` (`page.emulateMedia`; the drawer sends the theme, also when it changes); the page a window shows gets its viewport set
to the drawer's page area (debounced on resize; the agent sees that size too) and streams JPEG frames
(`page.screencast`, quality 100) to that window only, drawn on a canvas at its CSS size; the canvas's mouse, wheel, keys
and pasted text are replayed with `page.mouse` / `page.keyboard`. Frames are asked at the window's devicePixelRatio,
and on HiDPI screens the browsers render that many pixels: `browser-drawer/display-scale.ts` follows the screens'
largest scale factor (up to 2) into the runs' Playwright config (`setPlaywrightDisplayScale`: `deviceScaleFactor`, plus
`--force-device-scale-factor` for Chromium, whose screencast otherwise stays at CSS size), a small config file for runs
without a profile copy; screenshots for agents stay in CSS pixels. The renderer gets bytes and text only (no remote content, no webview).
The availability probe's browser is titled with Playwright's internal prefix, so it never shows. In WSL mode the
browsers, their registry and their Unix sockets are inside the distribution, which Windows can't connect to: the bridge
runs there with the distribution's node (`spawnTool`, script read through `/mnt`), the registry is read through
`\\wsl.localhost` (the distribution's `~/.cache/ms-playwright/b`), the bridge also says which of its browsers answer
(`probe`, `setRegistryAccess` in `registry.ts`), and workspace folders are matched to projects as Windows paths
(`toHostPath`). Chat browsers' holders run in the distribution too, their folders in its `~/.cache/workbench/tmp`
(`runtimeTempParent()`; a profile on a Windows drive is slow for a browser), which the startup sweep also looks in.

**Chat browsers** (`browser-drawer/chat-browsers.ts`) — each Claude chat has at most one browser, owned by Workbench, not
by a turn: it stays open between turns and while the user is on other chats or pages, so the user and the chat work in
the same pages (the user signs in or passes multi-factor checks by hand, then asks the chat to carry on). A long-lived
Playwright MCP server Workbench starts itself (the holder: the turn's server and browser options for the chat's browser,
its profile copy, `--idle-timeout 0`, a profile in its folder instead of `--isolated`) initializes with the chat's bind
title (`Workbench chat <uuid>`) and opens `about:blank`, so its browser is bound under that title; a turn's Playwright
gets `--endpoint <title>` and attaches to it (`contexts()[0]`). The chat's guard asks Workbench to open the browser
before each tool call (`open_chat_browser`, a token per turn on the task tools server) and refuses `browser_close`;
inside WSL2 with NAT networking (no way to the app's 127.0.0.1) it sends that call through the task tools bridge
(`task-tools-bridge.cjs`, a Windows process it starts once through interop: `WORKBENCH_CHAT_BROWSER_RELAY`), and with
interop off chats fall back to a browser per turn. The
drawer's empty state on the Claude page has the chat's browser profile picker (`InsightsModelConfig.playwrightBrowser`;
unset = Settings > Connectors; the New chat page starts from Settings) and an Open browser button, which also switches
Playwright on for the chat; the picker shows only while the chat has no browser (one profile per chat at a time). The
New chat page's browser (chat id `new`) moves to the conversation its first message creates. A chat browser closes when
the user closes its last tab, its chat is deleted, its browser goes away (its registry entry stops answering) or the
app quits.

**Crash leftovers** — Workbench's folders in the system temp folder (`temp-folders.ts`: `workbench-task-`,
`workbench-insights-`, `workbench-chat-browser-`, `workbench-browser-bridge-`, `workbench-mcp-probe-`) are made with an
owner file naming the Workbench process (`folder-owner.ts`, the same one profile copies have), and a task phase's or chat
turn's also names its Claude Code process. At startup (`removeCrashLeftovers()` in `index.ts`, in the background),
`browser-drawer/chat-browser-restore.ts` looks at the chat browsers a crash left: each holder folder keeps a record
(`.workbench-chat-browser.json`: project, chat, browser, profile copy, open tabs from the bridge), and a chat that still
exists keeps its newest one for 7 days (this process takes over the folder and its profile copy, which sweeps and
quitting then leave). The drawer offers it (`ChatBrowserInfo.status: 'restorable'`): the chat's next browser with the
same profile starts from that profile and reopens its tabs; another profile discards it. Then the temp folders no
running Workbench or run holds go (folders without an owner file only after an hour), then profile copies.

### Graphify Memory Graph

`src/main/graphify.ts` detects the `graphify` CLI (PyPI package `graphifyy`; status, version and install on
Settings > Updates) and builds a project's graph with `graphify extract <project> --code-only --out
.workbench/knowledge` (Settings > Project > Knowledge index), writing `graphify-out/graph.json`, `GRAPH_REPORT.md` and
an `index.json` summary. The project's "Use Graphify" switch (Settings > Project > Knowledge) is on while
`.workbench/knowledge` exists (`isGraphifyEnabled()`, `graphify-paths.ts`); switching it on builds the graph (the switch
is disabled while a build from the app runs, `memory-graph-store.ts`), switching it off stops a running build and
removes the folder, which hides the Graph item. While it is on, task runs and Claude chat get `GRAPHIFY_OUT`, the
graphify CLI on `PATH` and a prompt section about graphify's search commands (Claude chat limits Bash to those
commands). Installing Graphify also adds its `/graphify` skill to Claude Code (`graphify install` for `~/.claude` and
each Claude profile's config dir, after an install or update), and agent windows get `GRAPHIFY_OUT` and an
`--append-system-prompt` hint pointing `/graphify` at `.workbench/knowledge`.

### Claude chat

The Claude page (sidebar item "Claude"). Code and IPC keep the older Insights name: `src/main/insights/`,
`insights-service.ts`, `ipc-handlers/insights-handlers.ts`, `Insights.tsx`, `insights-store.ts`. Each turn is a
headless stream-json run built in `insights/claude-code-runner.ts`, on the project's Claude account:

- **One session per chat** — the first message starts a session (`--session-id`, named `Workbench chat: <title>`),
  later turns `--resume` it, and editing a sent message or regenerating a reply forks it at the earlier reply
  (`--resume <id> --resume-session-at <uuid> --fork-session`), leaving the original session as it was. Chats are saved
  in `.workbench/chats/` (`session-storage.ts`); a new chat is saved only once it has a message.
- **Chats reply at the same time** — one reply runs per chat (`insights-executor.ts`, keyed by project and chat), and
  switching chats, opening a new chat or leaving the page never stops one; Stop ends the reply of the chat it is pressed
  in, and deleting a chat stops its reply and closes its browser. Every event (stream chunks, status, errors) names its
  chat: the renderer streams the shown chat's reply and keeps the others' in `backgroundRuns` until they end (each is
  saved in its own chat), so a chat opened again shows its reply still streaming; the history marks replying chats.
- **Can't change the project's files** — `--tools` gives Read, Glob, Grep, WebFetch and WebSearch, plus Bash only for
  graphify's searches (Use Graphify on) and read-only `gh` / `glab` commands (the GitHub / GitLab buttons,
  `INSIGHTS_GITHUB_COMMANDS` / `INSIGHTS_GITLAB_COMMANDS` in `insights/prompts.ts`), and Edit/Write only for
  `.workbench/compeng/**` (Self-improve on). `--permission-mode dontAsk` denies everything else without asking.
  Playwright runs through `insights/playwright-guard.cjs`, in the turn's own folder without the client's roots, so
  its workspace root (where files a tool call names are written) is that folder, not the project; the guard also
  leaves out `browser_run_code_unsafe`. The chat may read that folder (`--add-dir`), where snapshots are linked.
  It attaches to the chat's own browser (see Chat browsers above); in WSL with interop off each turn launches its own.
- **MCP per chat** — `--strict-mcp-config` loads only the servers chosen in the chat's MCP menu
  (`InsightsMcpMenu.tsx`, the Connectors defaults until changed) and, with the Kanban button on, Workbench's task tools
  (`insights/task-tools.ts`, served over local MCP HTTP by `task-tools-server.ts` with a token per turn): they create,
  edit, start, stop, retry, move, review, PR, merge, archive and delete tasks through the same IPC handlers as the UI
  (`ipc-handlers/ipc-registry.ts`). The buttons are kept per chat (`InsightsModelConfig`).
- **System prompt** — `buildSystemPrompt()` (`insights/prompts.ts`) describes what the turn is given; it is sent every
  turn with `--append-system-prompt-file` and `--system-prompt-snapshot off` (Claude Code 2.1.267 or newer), so a
  resumed session doesn't keep its first turn's prompt.
- **Task suggestions** — ideas the user didn't ask for come back as `__TASK_SUGGESTION__:{...}` lines, which
  `src/shared/utils/task-suggestions.ts` turns into cards with a Create task button.

### Self-improve (project memory)

The project's Self-improve switch (Settings > Project > Knowledge, `selfImprove` in `.workbench/settings.json`) points
Claude Code's auto memory at `.workbench/compeng` (`src/main/self-improve/`): `autoMemoryDirectory` in the project's
`.claude/settings.local.json`, an import of the memory index (`MEMORY.md`) at the end of CLAUDE.md, inside the
`workbench:project-memory` comment markers (`relocation.ts` finds them by their full text, so never write them anywhere
else in the file), and the capture instruction (`nudge.ts`: when to save, and how to tell a lasting rule from a
one-off instruction) appended to task runs', chats' and agent windows' system prompts and kept in `.claude/MEMORY.md`
for other sessions. Memories use Claude Code's own format (`memory-writer.ts`). Memory index (Settings > Project)
builds memories from past sessions (`backfill.ts`), skipping Workbench's own turns (`claude-code/phase-prompts.ts`).
Switching off moves the memories aside to `.workbench/compeng.disabled` unless git tracks them.

### Live agent graph

The Live agent switch (Settings > Agents) shows agent-flow's graph of a project's Claude Code sessions next to each
agent window (`src/main/live-agent/`, `src/renderer/components/live-agent/`). It installs `.workbench/flow/hook.cjs`
and Claude Code hooks in the project's and its worktrees' `.claude/settings.local.json` (`project-setup.ts`); the
`.workbench/flow` folder's existence is the setting, switched on when a project is set up. A relay worker
(`live-agent-relay.ts`, `relay/`) runs while any project has it on; each window's graph shows only the sessions run in
it, never headless ones.

### Electron MCP (testing the app from a task)

Run `npm run dev` and switch on Electron in Settings > Connectors (or in the task's connectors). Claude Code can
then drive the running app over the Chrome DevTools Protocol with `get_electron_window_info`, `take_screenshot`,
`send_command_to_electron`, and `read_electron_logs`.

## Frontend

**Stack:** Electron 40, React 19, TypeScript (strict), Claude Code CLI, Zustand 5, XState 5, Tailwind CSS v4, Radix
UI, xterm.js 6, PixiJS 8 + d3-force-3d (Graph page), electron-vite 5 (Vite 7), Vitest 4 + React Testing Library +
jsdom.

**Path aliases:** `@/*` → `src/renderer/*`, `@shared/*` → `src/shared/*`, `@preload/*` → `src/preload/*`.

**Component files** — A `.tsx` component file exports only components (Fast Refresh); constants and helpers go in a
sibling `.ts` file (e.g. `settings/connector-meta.ts`, `icons/icon-paths.ts`).

**State (Zustand)** — Renderer stores live in `src/renderer/stores/` (`project-store.ts`, `task-store.ts`,
`terminal-store.ts`, `settings-store.ts`, `insights-store.ts` (Claude chat), `claude-profile-store.ts`,
`usage-store.ts`, `live-agent-store.ts`, `memory-graph-store.ts`, `self-improve-store.ts`, `project-index-store.ts`,
`terminal-font-settings-store.ts`, and `*-simulator-store.ts` for the Simulation page). Main-process stores:
`src/main/project-store.ts`, `src/main/terminal-session-store.ts`, `src/main/agent-session-store.ts`. Task and
terminal state machines (XState) live in `src/shared/state-machines/`.

**Styling** — Tailwind CSS v4 via `@tailwindcss/postcss`; `clsx` + `tailwind-merge` through `cn()`; variants with
`class-variance-authority`. One color theme (**Default**, `src/shared/constants/themes.ts`) with light/dark variants
via CSS custom properties in `src/renderer/styles/globals.css`. Elements with a `hover:` (or focus/highlight) style get
the pointer cursor automatically from a base rule.

**Fonts** — Bundled in `src/renderer/assets/fonts/`: Anthropic Sans (UI), Dank Mono (terminals and agent windows,
loaded with the FontFace API before xterm measures), Anthropic Serif (sidebar "Workbench" title only) and Inter
(optional interface font). Settings > General > Appearance picks the interface and command line fonts.

**Settings UI (claude.ai style)** — The dialog (`settings/AppSettings.tsx`) has one menu: General, Accounts, Agents,
Project, Connectors, Developer, Simulation (`npm run dev` builds only, `IS_DEV_BUILD`), Updates.

- **General** — Appearance (theme, graph colors, Shell on Windows, interface and command line fonts, display) and
  notifications.
- **Accounts** — Claude accounts, API profiles and Metrics (spending per project, `src/main/project-metrics.ts`).
- **Agents** — how tasks run (triage, planning, validation, Fable, fallback model, Task messaging, Live agent) and
  limits such as Maximum parallel tasks and the workflow size and concurrency.
- **Project** — the selected project's page: Project (Project index: CLAUDE.md written by Claude Code's `/init`,
  `src/main/project-index.ts`; Knowledge index: Graphify; Memory index: Self-improve), Knowledge (Use CLAUDE.md, Use
  Graphify, Self-improve), Tasks, Branches. The project's `useClaudeMd`, `maxBudgetUsd` (budget per task),
  `claudeProfileId` (its Claude account; unset = the account in use) and `selfImprove` are kept in its own
  `.workbench/settings.json` (`src/main/project-store.ts`). Each window shows and runs on its project's account:
  switching the account in a window saves it there, moves only that project's agent windows and makes it the
  account in use for projects without one (`src/main/project-account.ts`, `hooks/useWindowClaudeAccount.ts`).
- **Developer** — the CLI tools Workbench detects (`src/main/cli-tool-manager.ts`: Python, Node.js, git, gh, glab,
  claude) with path overrides (`nodePath`, `gitPath`, ...). Node.js (npx for MCP servers) is looked for in the
  configured path, PATH and version managers' folders, and only then asked of the login shell, with a timeout.
- **Simulation** — previews of the Live agent graph, the Graphify graph and the usage popover in any state and in
  both themes (`*SimulatorSettings.tsx`).
- **Updates** — Workbench updates (Beta updates, Auto-update projects), the Claude Code CLI and the Graphify CLI.

Build pages from `SettingsSection` + `SettingsRows`/`SettingsRow`; controls are switches, `SegmentedControl`,
borderless selects, or dropdown menus (no collapsible rows). UI copy conventions: sentence case, no em dashes, no
trailing period in setting descriptions, and no green check / red x status icons (state the status in text).

**Usage popover** — The header's usage indicator (`UsageIndicator.tsx`) opens `components/usage/`: the 5-hour limit
under Clawd's pixel sky (local time, moon phase, seasonal decor; `usage/clawd/`) and the weekly limits. Loading
overlays use `AgentLoader` (`ui/agent-loader.tsx`, the live agent node bouncing) instead of a spinner.

**IPC** — Handlers in `src/main/ipc-handlers/` (by domain), safe APIs exposed in `src/preload/`, renderer calls
`window.electronAPI.*`.

**Agent management** (`src/main/agent/`) — `agent-manager.ts` (starts, stops and restarts Claude Code task runs and
relays their events), `agent-state.ts` (profile/session assignment for account swapping).

**Claude profiles** (`src/main/claude-profile/`) — `credential-utils.ts` (OS keychain), `token-refresh.ts` (OAuth
refresh), `usage-monitor.ts` (usage and rate limits), `profile-scorer.ts` (profile selection). On every start,
`claude-code-detection.ts` finds Claude Code's own setups (`~/.claude`, `CLAUDE_CONFIG_DIR`, `~/.claude-*`: subscription
sign-in, cloud provider, API key or gateway, from managed settings, the dir's `settings.json` and the environment) and
lists them as accounts (`ClaudeProfile.detected`): usable and renamable, never removed. Claude Code's default `~/.claude`
runs without `CLAUDE_CONFIG_DIR`, keeps its sign-in in `~/.claude.json` and its plain keychain entry
(`config-dir-paths.ts`).

**Terminals** (`src/main/terminal/`) — `pty-manager.ts` (PTY processes), `terminal-lifecycle.ts`,
`cli-integration-handler.ts` (the `claude` command an agent window types: `--session-id`, one `--append-system-prompt`),
`claude-sessions.ts` (the Session menu: a directory's interactive sessions, newest first), `session-follower.ts` (shows
a running task's session in a window, read-only). Renderer uses xterm.js 6 with WebGL, fit, web-links, and serialize
addons.

## i18n

English is the only supported language. Translation files: `src/shared/i18n/locales/en/*.json`.

**Namespaces:** `common`, `navigation`, `settings`, `dialogs`, `tasks`, `taskReview`, `terminal`, `errors`,
`welcome`.

```tsx
import { useTranslation } from 'react-i18next';

const { t } = useTranslation(['navigation', 'common']);

<span>{t('navigation:items.kanban')}</span>                      // CORRECT
<span>Kanban</span>                                              // WRONG
<span>{t('errors:task.jsonError.description', { error })}</span> // With interpolation
```

## Cross-Platform

Supports Windows, macOS, and Linux; CI runs tests on all three. Use `src/main/platform/`:

| Function                                  | Purpose                           |
|-------------------------------------------|-----------------------------------|
| `isWindows()` / `isMacOS()` / `isLinux()` | OS detection                      |
| `getPathDelimiter()`                      | `;` (Win) or `:` (Unix)           |
| `getExecutableExtension()`                | `.exe` (Win) or empty             |
| `requiresShell(command)`                  | `.cmd/.bat` shell detection (Win) |
| `joinPaths(...parts)`                     | Platform-correct path joining     |
| `killProcessGracefully(proc)`             | Stop a process, force after 5s    |

Executable lookup is `findExecutable()` / `findExecutableAsync()` in `src/main/env-utils.ts`.

### Shell runtime (Windows: PWSH or WSL)

On Windows, Settings > General > Shell (`AppSettings.windowsShell`, `'pwsh'` by default, applied after a restart)
chooses where Workbench runs everything: natively with PowerShell agent windows (`pwsh.exe`, falling back to
Windows PowerShell 5.1), or inside WSL (the default distro). `src/main/platform/shell-runtime.ts`
(`initShellRuntime()` at startup, `whenShellRuntimeReady()`, `isWslRuntime()`, `getWslInfo()`,
`toRuntimePath()` / `toHostPath()`) holds the active runtime; `wsl-detect.ts` checks availability and probes the
distro once (user, home, login shell and PATH, mount root, networking, interop, tool paths). When WSL can't
start, the session runs natively and the Settings row says why. These modules are not re-exported from `platform/index.ts`.

- **Start tools through `runTool` / `spawnTool` / `killRuntimeProcess`** (`platform/runtime-exec.ts`) and git
  through `git()` (`utils/git-exec.ts`), never `execFile(getToolPath(...))` or a literal `'git'` spawn (an
  architecture test fails on those). In WSL mode they run `wsl.exe -d <distro> --cd <dir> --exec ...`, translate
  whole-argument Windows paths, and pass changed env vars through `WSLENV` (never PATH); in pwsh mode they behave
  as a plain spawn. `getToolPath()` and `getToolInfoAsync()` describe tools (Linux paths in WSL mode), they don't
  run them.
- **Stored paths stay Windows paths** (projects, worktrees, profile config dirs, the WSL Claude home as
  `\\wsl.localhost\<distro>\home\<user>`); translate only at process boundaries (args, cwd, env, prompt text,
  git output such as `worktree list --porcelain`).
- **Claude home:** use `getClaudeHome()` / `expandClaudeHome()` / `joinClaudeHome()` / `claudeProjectSlug()`
  (`platform/claude-home.ts`), not `os.homedir()`. WSL accounts live in the Linux home with file-only credentials
  and their own profile store (`claude-profiles.wsl.json`).
- **Agent windows** know their `shellKind` (`'cmd' | 'powershell' | 'posix'`); command builders in
  `terminal/cli-integration-handler.ts` and `shared/utils/shell-escape.ts` choose syntax from it, not from
  `isWindows()`. WSL windows type bash syntax (wrapped in `bash -c` when the login shell is fish).
- **WSL2 NAT networking** can't reach the app's `127.0.0.1`: Claude chat's task tools go through a stdio bridge
  (`insights/task-tools-bridge.cjs`) run as a Windows process through interop, and the Live agent hook command has
  a WSL branch. Watchers poll `\\wsl.localhost` paths (`fs.watch` fails there).
- **Worktrees** use relative links only when both runtimes' git is 2.48 or newer; on a runtime switch,
  `worktree/runtime-switch.ts` repairs every project's worktrees in the background.

## Known Gotchas

**Electron path resolution** — Paths often differ between dev and packaged builds (`app.isPackaged`,
`process.resourcesPath`). In dev, `__dirname` is `out/main`; in production, bundled assets live under
`process.resourcesPath`. Verify both contexts.

<!-- workbench:project-memory:start -->
Preferences learned in past sessions: @.workbench/compeng/MEMORY.md
<!-- workbench:project-memory:end -->
