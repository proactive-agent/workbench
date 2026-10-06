# Aperant (formerly Auto Claude)

**Autonomous multi-agent coding framework that plans, builds, and validates software for you.**

[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/KCXaPBr4Dj)
[![YouTube](https://img.shields.io/badge/YouTube-Subscribe-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://www.youtube.com/@AndreMikalsen)
[![CI](https://img.shields.io/github/actions/workflow/status/AndyMik90/Aperant/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/AndyMik90/Aperant/actions)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge-flat.svg)](https://github.com/hesreallyhim/awesome-claude-code)

---

## 🚀 Status: Aperant 3.0 in active development

> **Aperant is alive and under active development — it is _not_ abandoned.**
>
> We're rebuilding the entire app **from the ground up** for **Aperant 3.0**, which adds **cloud features** on top of the local desktop experience. Aperant 3.0 will stay **fully open source under AGPL-3.0**.
>
> **Why this repo looks quiet:** most of the 3.0 work is happening in a separate development repository right now and will be merged back here once it's ready. So even though commits look sparse on the surface, the project is very much alive and moving fast behind the scenes.
>
> **What this means today:**
> - 🛠️ **The current 2.x desktop app is in maintenance mode** — it's stable and usable, but new development is going into 3.0.
> - 🚫 **Pull requests are paused.** Because the codebase is being rebuilt from scratch, code PRs against the current app can't be merged and will be closed. Please hold off on opening them for now.
> - 💬 **We still want your input.** [Open an issue](https://github.com/AndyMik90/Aperant/issues), [start a discussion](https://github.com/AndyMik90/Aperant/discussions), or [join our Discord](https://discord.gg/KCXaPBr4Dj) to report bugs and help shape what 3.0 becomes.
>
> _No public release date yet — ⭐ star and watch the repo (or join Discord) to follow progress._

---

## Requirements

- **Claude Pro/Max subscription** - [Get one here](https://claude.ai/upgrade)
- **Claude Code CLI** - `npm install -g @anthropic-ai/claude-code`
- **Git repository** - Your project must be initialized as a git repo

---

## Quick Start

1. **Download and install** the app for your platform
2. **Open your project** - Select a git repository folder
3. **Connect Claude** - The app will guide you through OAuth setup
4. **Create a task** - Describe what you want to build
5. **Watch it work** - Agents plan, code, and validate autonomously

---

## Features

| Feature | Description |
|---------|-------------|
| **Autonomous Tasks** | Describe your goal; agents handle planning, implementation, and validation |
| **Parallel Execution** | Run multiple builds simultaneously with up to 12 agent terminals |
| **Isolated Workspaces** | All changes happen in git worktrees - your main branch stays safe |
| **Self-Validating QA** | Built-in quality assurance loop catches issues before you review |
| **AI-Powered Merge** | Automatic conflict resolution when integrating back to main |
| **Memory Layer** | Agents retain insights across sessions for smarter builds |
| **GitHub/GitLab Integration** | Import issues, investigate with AI, create merge requests |
| **Linear Integration** | Sync tasks with Linear for team progress tracking |
| **Cross-Platform** | Native desktop apps for Windows, macOS, and Linux |
| **Auto-Updates** | App updates automatically when new versions are released |

---

## Interface

### Kanban Board
Visual task management from planning through completion. Create tasks and monitor agent progress in real-time.

### Agent Terminals
AI-powered terminals with one-click task context injection. Spawn multiple agents for parallel work.

### Roadmap
AI-assisted feature planning with competitor analysis and audience targeting.

### Additional Features
- **Insights** - Chat interface for exploring your codebase
- **Ideation** - Discover improvements, performance issues, and vulnerabilities
- **Changelog** - Generate release notes from completed tasks

---

## Project Structure

```
auto-claude/
├── src/             # Electron app (main process, preload, React renderer, AI agent layer)
├── prompts/         # Agent system prompts
├── resources/       # App icons and bundled header icons
├── e2e/             # Playwright end-to-end tests
└── .github/         # CI, E2E and release workflows; scripts/ (install, packaging and release helpers)
```

---

## Development

Want to build and run from source? Run `npm install`, then `npm run dev`. See the scripts below.

---

## Security

Aperant uses a three-layer security model:

1. **OS Sandbox** - Bash commands run in isolation
2. **Filesystem Restrictions** - Operations limited to project directory
3. **Dynamic Command Allowlist** - Only approved commands based on detected project stack

All releases are:
- Include SHA256 checksums for verification
- Code-signed where applicable (macOS)

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm install` | Install all dependencies |
| `npm start` | Build and run the desktop app |
| `npm run dev` | Run in development mode with hot reload |
| `npm run package` | Package for current platform |
| `npm run package:mac` | Package for macOS |
| `npm run package:win` | Package for Windows |
| `npm run package:linux` | Package for Linux |
| `npm test` | Run frontend tests |

---

## Contributing

> 🚫 **Pull requests are paused while we rebuild for Aperant 3.0.** The current codebase is being replaced from the ground up, so code PRs against it can't be merged and will be closed. This is temporary — contribution will reopen once the 3.0 foundation lands.

**You can still help shape Aperant right now:**
- 🐛 [Report bugs](https://github.com/AndyMik90/Aperant/issues) you hit in the current app
- 💡 [Share ideas and feature requests](https://github.com/AndyMik90/Aperant/discussions) for 3.0
- 💬 [Join the Discord](https://discord.gg/KCXaPBr4Dj) to follow development and influence the roadmap


---

## Community

- **Discord** - [Join our community](https://discord.gg/KCXaPBr4Dj)
- **Issues** - [Report bugs or request features](https://github.com/AndyMik90/Aperant/issues)
- **Discussions** - [Ask questions](https://github.com/AndyMik90/Aperant/discussions)

---

## License

**AGPL-3.0** - GNU Affero General Public License v3.0

Aperant is free to use. If you modify and distribute it, or run it as a service, your code must also be open source under AGPL-3.0.

Commercial licensing available for closed-source use cases.

---

## Star History

[![GitHub Repo stars](https://img.shields.io/github/stars/AndyMik90/Aperant?style=social)](https://github.com/AndyMik90/Aperant/stargazers)

[![Star History Chart](https://api.star-history.com/svg?repos=AndyMik90/Aperant&type=Date)](https://star-history.com/#AndyMik90/Aperant&Date)
