# ARCHITECTURE

This file is the structure map for the coding and review agent collaborating in this repository.
It describes how the repo is organized and where new code belongs.
It is not the behavioral source of truth for the runtime agent implemented under `src/`.

Behavioral details still live in the design and task-contract docs under `docs/plans/` and `docs/task_contract/`.

## Top-Level Map

Architecture ID: `ARCH-TOPLEVEL-001`

Approved top-level modules under `src/` fall into two groups:

- Core domains:
  - `conversation`: durable session, run, message, and transcript state
  - `permission`: durable permission-request state and decision flow
  - `model`: model-provider integration and transcript projection
  - `tool`: tool catalog, execution, and tool-side runtime helpers
  - `orchestration`: the agent loop, run progression, suspend/resume, streaming, and cross-domain coordination through explicit ports
- Outer-shell top-levels:
  - `wiring`: the current composition root and entrypoint location
  - `cli`, `server`, `app-server`, and `bootstrap`: reserved outer-shell names that may appear as the current `src/wiring/*` extraction continues

Legacy top-level directories such as `src/providers` and `src/runtime` are not allowed to reappear.

The current tree does not contain `src/utils/`.
If a later change needs a shared utility layer, update this file and the structure checks in the same change instead of introducing it implicitly.

## Domain Layers

Architecture ID: `ARCH-LAYER-001`

Each core domain uses a fixed layer vocabulary plus a root `index.ts`.
New code should stay within these layer names:

- `types`
- `config`
- `repo`
- `ports`
- `service`
- `runtime`
- domain root `index.ts`

The target architecture is that every core domain carries all six layers plus its root `index.ts`.
Current omissions are intentional ratchet debt: they should surface in the structure findings instead of relaxing the rule.

Allowed same-domain dependency directions:

- `config -> types`
- `repo -> config`
- `service -> repo`
- `service -> ports`
- `runtime -> service`
- same-layer imports when the file role stays within the same layer

Anything else is a layer violation.
In particular:

- `ports` must not import `types`, `config`, `repo`, `service`, or `runtime`
- `runtime` must not import `repo`, `ports`, `config`, or `types`
- `repo` must not bypass `config` to reach `types`
- domain-local `wiring/` is no longer an approved target pattern for new code

## Cross-Domain Boundaries

Architecture ID: `ARCH-CROSS-001`

Cross-domain imports are tightly constrained:

- core domain files may not import another core domain directly
- outer-shell top-levels may import a core domain only through `src/<domain>/index.ts`
- core domains must not depend on outer-shell code

The outer shell is an assembly boundary, not a loophole.
If composition needs another domain's internals, the fix is to export a public API from that domain's root `index.ts` and inject dependencies from an outer-shell top-level.

Positive examples:

- Target pattern: `src/wiring/main.ts -> src/orchestration/index.ts`
- Target pattern: `src/server/app.ts -> src/model/index.ts`

Negative examples:

- `src/model/runtime/api.ts -> src/model/repo/index.ts`
- `src/model/wiring/provider.ts -> src/orchestration/ports/model.ts`
- `src/wiring/main.ts -> src/model/wiring/provider.ts`

The second and third examples are current tracked debt; they are not legal patterns for new code.

## Placement Guide

Use these questions to place new code:

- New domain-owned data shapes, enums, and persisted record structures: put them in the owning domain's `types/`
- Domain-owned defaults, canonical constant sets, and configuration values that other layers read but do not persist themselves: put them in the owning domain's `config/`
- Repository contracts, durable read/write interfaces, storage mappers, and database-backed implementations: put them in the owning domain's `repo/`
- Business rules over one domain's state: put them in that domain's `service/`
- Long-lived runtime orchestration, streaming, suspend/resume, or run registries: put them in `orchestration/runtime/`
- Concrete runtime integrations and adapter behavior that fulfill a domain contract: put them in that domain's `runtime/`
- Cross-domain capability contracts consumed by a domain: define them in that domain's `ports/`
- The public module exit for a domain: put it in `src/<domain>/index.ts`
- Final composition and entrypoints: put them in an outer-shell top-level, using `src/wiring/*` today; extraction to `src/cli/*`, `src/server/*`, `src/app-server/*`, or `src/bootstrap/*` is allowed without another harness rename
- Existing domain-local `wiring/*` code should be treated as migration debt, not as the placement target for new code

If a change needs a new directory name or a new cross-domain shortcut, stop and update the harness docs and checks first.

## Known Debt

The current no-new-violations baseline is tracked in `test/structure/baselines/architecture-findings.json`.

As of 2026-03-19, the remaining structural debt includes:

- Missing root `index.ts` files across all current core domains
- Missing required layers in several current domains
- Domain-local `wiring/*` directories that still hold composition code
- Outer-shell composition in `src/wiring/*` that still reaches into domain internals
- `src/orchestration/wiring/*`, which currently mixes outer-shell concerns with cross-domain imports to concrete `conversation/*`, `permission/*`, and `tool/*` paths

Those findings are tolerated only because they are recorded as baseline debt.
New violations outside that baseline should fail the structure checks immediately.
