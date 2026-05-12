# ARCHITECTURE

This file is the structure map for the coding and review agent collaborating in this repository.
It describes how the repo is organized and where new code belongs.
It is not the behavioral source of truth for the runtime agent implemented under `src/`.

Behavioral details still live in the design docs under `docs/plans/`.

## Top-Level Map

Architecture ID: `ARCH-TOPLEVEL-001`

Approved top-level modules under `src/` fall into four groups:

- Capability modules:
  - `agent`: agent profile definitions, schema validation, and multi-agent configuration contracts
  - `memory`: Persistent user-level memory (Markdown-backed, cross-session)
  - `observability`: runtime telemetry, trace export policy, and durable run-event records
  - `session`: durable session, run, timeline entry, and timeline part state
  - `permission`: durable permission-request state and decision flow
  - `model`: model-provider integration and timeline projection
  - `skill`: skill catalog, skill loading, and skill activation semantics
  - `tool`: tool catalog, execution, and tool-side runtime helpers
- Coordinator module:
  - `orchestration`: the agent loop, run progression, suspend/resume, streaming, and coordination through explicit capability ports
- Shell modules:
  - `bootstrap`: shared composition root and cross-module assembly
  - `cli`: CLI client surface, transport, and entrypoint
  - `app-server`: HTTP/SSE App Server adapter and entrypoint
  - `desktop`: desktop App Client surface, entrypoint, and local UI shell
- Shared kernel:
  - `kernel`: truly global, stable, non-business contracts only

Legacy pre-refactor top-level names are not allowed to reappear:

- `conversation`: replaced by `session`
- `wiring`: replaced by `bootstrap`, `cli`, `app-server`, and `desktop`
- `server`: replaced by `app-server`
- `providers`
- `runtime`

The current tree does not contain `src/kernel/` yet.
If a later change introduces it, it must start with `contracts/` plus a root `index.ts`; do not use it as a generic shared-types or shared-utils bucket.

The current tree also does not contain `src/utils/`.
If a later change needs a shared kernel, use `src/kernel/` narrowly and update the structure checks in the same change instead of introducing `src/utils/` implicitly.

## Module Layouts

Architecture ID: `ARCH-LAYER-001`

The old fixed six-layer template (`types / config / repo / ports / service / runtime`) is retired as the target architecture.
New code in this refactor must follow module-role-specific layouts instead.

### Capability Modules

`agent`, `memory`, `observability`, `session`, `permission`, `model`, `skill`, and `tool` are capability modules.

Their target internal layout is:

- `public/`
- `application/`
- `domain/`
- `infrastructure/`
- root `index.ts`

`application/ports/` is optional inside `application/`.
It is used only for outbound dependency contracts that the application layer consumes.

### Coordinator Module

`orchestration` is a coordinator module.
It does not use the same template as the capability modules.

Its target internal layout is:

- `public/`
- `application/`
- `infrastructure/`
- root `index.ts`

`orchestration/application/ports/` defines the capability contracts that `orchestration` needs from `memory`, `observability`, `session`, `permission`, `model`, `skill`, and `tool`.

`orchestration` does not gain a mandatory `domain/` directory in this round.
If future work reveals durable, reusable orchestration-owned business rules that deserve a `domain/`, that must come from a later design change, not from ad hoc implementation drift.

### Infrastructure Subroles

`infrastructure` remains the technical implementation layer.
It owns how a module's behavior is realized with concrete technology and module-local runtime control mechanisms.
It is not a fallback bucket for contracts with unclear ownership.

`infrastructure` may own:

- provider, database, file-system, shell, and network integrations
- event queues, registries, pending maps, suspension controllers, and loop drivers
- module-local runtime assembly helpers that connect application use cases to technical machinery
- other technical implementation details that are neither public-boundary contracts nor business-semantic rules

`infrastructure` does not own:

- business rules or status-transition meaning
- the module's public boundary
- cross-module composition

Modules do not need to create a fixed set of infrastructure subroles.
Use only the subroles that match real ownership in that module.
This vocabulary does not apply to shell modules.

- `infrastructure/adapters/` is the strict port-implementation subrole.
  Files here implement precise application-owned outbound dependency contracts.
- `infrastructure/runtime/` is the machinery subrole.
  Files here own queues, registries, pending maps, suspension controllers, loop drivers, and runtime-only assembly.
- other infrastructure subroles such as `infrastructure/builtins/` are allowed when they express a real technical owner inside the generic infrastructure boundary

### Shell Modules

`bootstrap`, `cli`, `app-server`, and `desktop` are shell modules.

Shell modules do not share a fixed subdirectory vocabulary in this round.
They own transport, adapter, entrypoint, and composition behavior according to their role:

- `bootstrap` owns cross-module assembly
- `cli` owns CLI client presentation, transport, and entrypoint behavior
- `app-server` owns HTTP and SSE exposure of the App Server boundary
- `desktop` owns the desktop App Client surface, local UI shell, and desktop-specific operator behavior

CLI and Desktop are App Clients.
They must drive Neo Coworker through the App Server boundary.
The CLI may use an in-process App Server adapter for local one-shot use, but that adapter must preserve the same App Server semantics instead of becoming a separate product model.

### Shared Kernel

`kernel` is an allowed shared-kernel top-level only for a very small set of truly global, stable, non-business contracts.

Its target internal layout is:

- `contracts/`
- root `index.ts`

Allowed examples include:

- clocks
- ID generators
- telemetry contracts
- other small, truly global capability contracts

Forbidden examples include:

- `RunStatus`
- `PermissionDecision`
- `Session`, `Run`, `Message`, `Part`, or other module-owned business concepts
- module-owned runtime events
- module-specific defaults or policies

## Internal Module Boundaries

Architecture ID: `ARCH-LAYER-002`

### Capability Module Boundaries

For capability modules, the approved dependency directions are:

- `application -> domain`
- `application -> application/ports`
- `infrastructure -> application`
- `infrastructure -> domain` only when necessary
- `public -> application`
- `public -> infrastructure` only to expose stable module-owned public factories or adapters
- root `index.ts -> public`
- same-layer imports when the file role stays within the same layer

Inside `infrastructure`, subroles tighten placement further:

- `infrastructure/adapters/**/*` may import only precise `application/ports/*` contracts, necessary `domain/*` contracts, `src/kernel/index.ts`, same-layer infrastructure helpers, and external/platform APIs
- `infrastructure/runtime/**/*` may import precise `application/*` contracts when the machinery needs them
- machinery-only contracts must stay with the owning runtime machinery instead of being parked in `application`

Anything else is a layer violation.
In particular:

- `domain` must not import `application`, `public`, or `infrastructure`
- `application` must not import `public` or `infrastructure`
- `public` must not import `domain` directly
- `public` must not contain business logic or hidden side-effect initialization
- module-internal files must not import their own root `index.ts`

### Coordinator Module Boundaries

For `orchestration`, the approved dependency directions are:

- `application -> application/ports`
- `infrastructure -> application`
- `public -> application`
- `public -> infrastructure` only to expose stable module-owned public factories or adapters
- root `index.ts -> public`
- same-layer imports when the file role stays within the same layer

Inside `infrastructure`, subroles tighten placement further:

- `infrastructure/adapters/**/*` may import only precise `application/ports/*` contracts, `src/kernel/index.ts`, same-layer infrastructure helpers, and external/platform APIs
- `infrastructure/runtime/**/*` may import precise `application/*` contracts when the machinery needs them
- machinery-only contracts must stay with the owning runtime machinery instead of being parked in `application`

Anything else is a layer violation.
In particular:

- `orchestration/application` must not import `session`, `permission`, `model`, `skill`, or `tool`
- `orchestration/public` must not contain business logic or hidden side-effect initialization
- `orchestration` files must not import outer-shell code
- module-internal files must not import `src/orchestration/index.ts`

## Cross-Module Boundaries

Architecture ID: `ARCH-CROSS-001`

Cross-module imports are tightly constrained:

- capability modules may not import another capability module directly
- capability modules may not import `orchestration`
- `orchestration` may not import capability modules directly
- `bootstrap` may import capability and coordinator modules only through `src/<module>/index.ts`
- non-`bootstrap` shell modules may import only `src/bootstrap/index.ts` and `src/kernel/index.ts` across module boundaries
- capability modules, `orchestration`, and shell modules may import `kernel` only through `src/kernel/index.ts`
- `kernel` must not import capability modules, `orchestration`, or shell modules
- capability modules and `orchestration` must not depend on shell code
- `bootstrap` is the only approved place where multiple module APIs are wired together into a running application graph

The outer shell is not a loophole.
If composition needs another module's internals, the fix is to export a public capability from that module's `public/` layer and wire it together in `bootstrap`.

Positive examples:

- Target pattern: `src/bootstrap/runtime.ts -> src/orchestration/index.ts`
- Target pattern: `src/app-server/app.ts -> src/bootstrap/index.ts`
- Target pattern: `src/desktop/app.ts -> src/bootstrap/index.ts`

Negative examples:

- `src/app-server/app.ts -> src/session/repo/index.ts`
- `src/model/infrastructure/openai.ts -> src/tool/index.ts`
- `src/orchestration/application/run.ts -> src/session/index.ts`

All three examples are forbidden patterns.

## Public Export Contract

Architecture ID: `ARCH-PUBLIC-001`

The public export contract is:

- every capability, coordinator, shell, and kernel module has one public module exit: `src/<module>/index.ts`
- root `index.ts` re-exports only from `./public` for capability and coordinator modules, and only from `./contracts` for `kernel`
- `public/` is the only internal layer allowed to define a capability or coordinator module's public surface
- `public/` may re-export application contracts and stable infrastructure-backed factories or adapters that are intentionally part of the module boundary
- public surfaces must not rely on multi-hop re-export ladders through retired implementation layers
- compatibility re-export layers such as `public.ts`, `compat.ts`, or `exports.ts` are forbidden

Examples of forbidden patterns:

- `index.ts -> runtime/api.ts -> service/index.ts -> repo/index.ts`
- `service/index.ts -> export * from "../repo"`
- `runtime/api.ts -> export * from "../service"`
- bridge files that exist only to tunnel a symbol through multiple layers

## Placement Guide

Use these questions to place code:

- Is this core business meaning, rule, state transition, or domain-owned error? Put it in `domain/`.
- Is this a use case, command, query, workflow, or a port the use case needs? Put it in `application/`.
- Is this a concrete implementation detail such as SQLite, OpenAI, file system, shell, event queue, or in-memory registry? Put it in `infrastructure/`.
- Is this specifically a port implementation over a precise application-owned contract? Put it in `infrastructure/adapters/`.
- Is this queue, registry, pending map, suspension handle, loop driver, or other machinery-only control contract? Put it in `infrastructure/runtime/`.
- Is this a module-specific technical owner such as builtin tool definitions? Put it in a precise infrastructure subrole such as `infrastructure/builtins/` instead of inventing a fake public or application owner.
- If no precise owner is obvious, stop and re-evaluate the boundary instead of treating `infrastructure/` as a generic catch-all.
- Is this the module's explicit public boundary, a stable factory or adapter meant for callers, or a light boundary projection over application contracts? Put it in `public/`.
- Is this a truly global, stable, non-business contract with no single-module owner? Put it in `kernel/contracts/`.
- Is this cross-module composition or application assembly? Put it in `bootstrap/`.
- Is this CLI client presentation, transport, or entrypoint behavior over the App Server contract? Put it in `cli/`.
- Is this HTTP or SSE exposure of the App Server boundary? Put it in `app-server/`.
- Is this desktop App Client product-surface or local UI shell behavior? Put it in `desktop/`.

Defaults, constants, and policy values follow the owner that is responsible for interpreting them:

- business-semantic defaults and domain-owned constant sets go in `domain/`
- use-case policy defaults and application-owned strategy values go in `application/`
- adapter and implementation defaults go in `infrastructure/`
- deployment, entrypoint, and operator-environment defaults go in shell modules
- `kernel` never owns module defaults or strategy values

If a change needs a new directory name, a new cross-module shortcut, or a broader `kernel`, stop and update the design docs and structure checks first.


## Runtime Data, Skills, And Research Artifacts

Architecture ID: `ARCH-RUNTIME-PATHS-001`

Neo Coworker separates app-state storage from workspace execution storage. App-state files live under XDG roots:

- config root: `$XDG_CONFIG_HOME/neo-coworker`, falling back to `~/.config/neo-coworker`
- data root: `$XDG_DATA_HOME/neo-coworker`, falling back to `~/.local/share/neo-coworker`

The data root owns app-state files such as the standalone server database, desktop state, desktop settings, and the adjacent `models.dev.json` cache. Workspace runtime and session storage may still live under the selected workspace root, for example `workspaceRoot/.ncoworker/agent.sqlite`. Do not treat the workspace execution root as the app-state root.

Deep Research artifacts are workspace-local files under `.ncoworker/research/<topic>/`. The MVP uses living topic directories, not timestamped run directories. Artifact content is files-only and git-readable, with paths such as `.ncoworker/research/index.md`, `.ncoworker/research/<topic>/brief.md`, `.ncoworker/research/<topic>/findings.md`, `.ncoworker/research/<topic>/open-questions.md`, and source records under `.ncoworker/research/<topic>/sources/{web,docs,files}/`. This does not imply a research UI, source viewer, or artifact viewer.

Skill packages use a required `SKILL.md` entry file plus optional support directories: `references/`, `scripts/`, `assets/`, and `examples/`. Support files are listed for progressive disclosure and are not automatically injected into model context. Load a support file only when the workflow explicitly needs it.

Skill resolution precedence is:

1. workspace `.ncoworker/skills`
2. user-global skills under the XDG config root
3. built-in skills materialized under `$XDG_DATA_HOME/neo-coworker/builtin-skills/`

Workspace skills may be created, patched, and deleted. User-global and built-in skills are load-only in the current runtime. Create, patch, and delete are workspace-only operations and must affect workspace `.ncoworker/skills/**` only. Built-in skills materialize directly under the data-root `builtin-skills/` directory, with no `current/`, version, timestamp, or release-channel folder.

## Enforcement State

The structure baseline at `test/structure/baselines/architecture-findings.json` is expected to remain empty in this final state.
Any structure finding from `bun run test:structure` is treated as an architecture violation that must be fixed in the same change.
