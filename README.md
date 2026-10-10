# Auto Claude

Auto Claude is a desktop app for Windows, macOS, and Linux that turns a written task into finished, reviewed code. You
describe what you want built; AI agents write a spec, plan the work into subtasks, implement it, and run QA on the
result, all inside an isolated git worktree so your main branch stays untouched until you review and merge.

## Features

- **Autonomous tasks**: a multi-agent pipeline (spec creation, planner, coder with parallel subagents, QA reviewer and
  fixer) that builds features end to end
- **Kanban board**: follow every task from planning through completion
- **Agent terminals**: parallel AI-powered terminals (12 by default, up to 24) with task context injected
- **Insights**: chat with an AI to explore and understand your codebase
- **Pull requests**: create a GitHub pull request from a task's worktree (uses the `gh` CLI)
- **Memory**: a local knowledge store that keeps insights across sessions
- **Connectors**: MCP servers for agents (Context7, Electron and Puppeteer for QA, plus your own), with app-wide
  defaults in Settings and per-task choices in the task dialog
- **Graphify memory graph**: optionally build a [Graphify](https://github.com/Graphify-Labs/graphify) knowledge graph
  of your project's code and give it to agents
- **Isolated workspaces**: every build runs in its own git worktree, with AI-powered semantic merge
- **Flexible authentication**: a Claude Code subscription (OAuth) or API profiles with any Anthropic-compatible
  endpoint, plus other providers such as OpenAI, Google, Bedrock, Azure, Mistral, Groq, xAI, OpenRouter, Z.AI, and
  Ollama
- **Multi-account swapping**: switch automatically to another Claude account when one hits a rate limit
- **Cross-platform**: Windows, macOS, and Linux, with auto-updates

## How it works

1. Create a task and describe your goal.
2. The spec pipeline assesses complexity and writes a specification.
3. The planner breaks it into subtasks and the coder implements them.
4. The QA reviewer validates the result and the QA fixer resolves issues.
5. You review the worktree and merge.

See [CLAUDE.md](CLAUDE.md) for development, packaging, and architecture notes.
