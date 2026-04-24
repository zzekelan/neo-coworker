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

## Other Scripts

| Script | Description |
| --- | --- |
| `bun run dev chat` | Run the CLI entrypoint |
| `bun run server` | Start the HTTP/SSE app server |

## Documentation

- Architecture: `docs/ARCHITECTURE.md`
- Development: `docs/dev/`

