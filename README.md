# Neo Coworker

**English** · [简体中文](README.zh-CN.md)

**Neo Coworker** is a file-system–based agent I built for my own day-to-day work. It has tool use, standard agent skills, permission prompts, subagents, context management (auto and manual compaction included), and folder-scoped workspaces.

## Quick Start (Desktop)

- From the project root, this single command installs dependencies and launches the Electron desktop app:
  ```bash
  bun run desktop:start
  ```

- On first launch, you can fill in the LLM settings directly from the in-app settings UI. If a `.env` exists in the project root, its values are used as the initial defaults for that UI.

## Why Neo Coworker?

- **Because I love building it, dude.**

- **Why not the web apps from the big AI vendors?**
  - They usually can't reach your local file system — you end up shuffling files and edits around by hand
  - Tool calls are stuck inside the vendor's sandbox; no local commands, scripts, or local services
  - Your code, notes, and private data have to leave your machine

- **Why not the agents from the big vendors?**
  - Most of them are coding agents — their prompts are tuned for coding, and tuned specifically for the vendor's own models
  - Model, pricing, and rate limits are all on the vendor's leash
  - **I can shape it around the way I actually work, instead of living with whoever's dumb design decisions**

## Requirements

- [Bun](https://bun.sh/)
- Linux and macOS for now; on Windows, WSL is recommended.


## Runtime Paths

Neo Coworker separates app-state roots from workspace execution roots. App-state files such as the standalone server database, desktop state, desktop settings, and the adjacent `models.dev.json` cache live under XDG roots:

- config root: `$XDG_CONFIG_HOME/neo-coworker`, falling back to `~/.config/neo-coworker`
- data root: `$XDG_DATA_HOME/neo-coworker`, falling back to `~/.local/share/neo-coworker`

Workspace runtime and session storage stays workspace-local under `.ncoworker`, including `workspaceRoot/.ncoworker/agent.sqlite`. Deep Research artifacts are plain workspace files under `.ncoworker/research/<topic>/`; the MVP has no research UI, source viewer, or artifact viewer.

Skills load in this precedence order: workspace `.ncoworker/skills`, user-global XDG config skills, then built-in skills materialized under `$XDG_DATA_HOME/neo-coworker/builtin-skills/`. Skill create, patch, and delete operations affect workspace `.ncoworker/skills/**` only. Built-in and user-global skills are load-only.

## Other Scripts

| Script | Description |
| --- | --- |
| `bun run dev chat` | Run the CLI entrypoint |
| `bun run server` | Start the HTTP/SSE app server |

## Documentation

- Architecture: `docs/ARCHITECTURE.md`
- Development: `docs/dev/`

