# ARCHITECTURE

This file is the structure map for the coding and review agent collaborating in this repository.
It describes how the repo is organized and where new code belongs.
It is not the behavioral source of truth for the runtime agent implemented under `src/`.

Behavioral details still live in the design and task-contract docs under `docs/plans/` and `docs/task_contract/`.

## Top-Level Map

Architecture ID: `ARCH-TOPLEVEL-001`

Approved top-level modules under `src/`:

- `conversation`: durable session, run, message, and transcript state
- `permission`: durable permission-request state and decision flow
- `model`: model-provider integration and transcript projection
- `tool`: tool catalog, execution, and tool-side runtime helpers
- `orchestration`: the agent loop, run progression, suspend/resume, streaming, and cross-domain coordination through explicit ports
- `wiring`: root entrypoints that assemble domain wiring into the CLI and standalone server

Legacy top-level directories such as `src/providers`, `src/runtime`, `src/server`, and `src/cli` are not allowed to reappear.

The current tree does not contain `src/utils/`.
If a later change needs a shared utility layer, update this file and the structure checks in the same change instead of introducing it implicitly.

## Domain Layers

Architecture ID: `ARCH-LAYER-001`

Each business domain uses a fixed layer vocabulary.
Not every domain needs every layer, but new code must stay within these names:

- `types`
- `config`
- `repo`
- `ports`
- `service`
- `runtime`
- `wiring`

Allowed same-domain dependency directions:

- `config -> types`
- `repo -> config`
- `service -> repo`
- `service -> ports`
- `runtime -> service`
- `wiring -> runtime`
- `wiring -> ports`
- same-layer imports when the file role stays within the same layer

Anything else is a layer violation.
In particular:

- `runtime` must not import `repo`, `ports`, `config`, or `types`
- `repo` must not bypass `config` to reach `types`
- `wiring` must not import `service`, `repo`, `config`, or `types` inside the same domain
- ad-hoc layer names such as `adapter`, `handlers`, or `controllers` are not part of this repo's structure contract

`ports/` exists only for explicit external capabilities that a domain consumes from elsewhere.
If a domain has no external capability boundary, omit `ports/` entirely rather than creating a placeholder.

## Cross-Domain Boundaries

Architecture ID: `ARCH-CROSS-001`

Cross-domain imports are tightly constrained:

- `src/wiring/*.ts` may import `<domain>/wiring/*`
- `<domain>/wiring/*` may import another domain only through that domain's `ports/*`
- all other cross-domain imports are forbidden

`wiring` is an assembly boundary, not a loophole.
If composition needs another domain's repo, service, runtime, or wiring internals, the fix is to add or use an explicit port or move the composition to `src/wiring/*`.

Positive examples:

- `src/model/wiring/provider.ts -> src/orchestration/ports/model.ts`
- `src/wiring/main.ts -> src/orchestration/wiring/cli.ts`

Negative examples:

- `src/model/runtime/api.ts -> src/model/repo/index.ts`
- `src/orchestration/wiring/runtime.ts -> src/conversation/repo/index.ts`

The second example currently exists as tracked debt; it is not a legal pattern for new code.

## Placement Guide

Use these questions to place new code:

- New persisted entities, transcript records, or repository contracts: put them in the owning domain's `types/`, `config/`, or `repo/`
- Business rules over one domain's state: put them in that domain's `service/`
- Long-lived runtime orchestration, streaming, suspend/resume, or run registries: put them in `orchestration/runtime/`
- Provider or adapter implementation details that fulfill a domain contract: put them in that domain's `runtime/`
- Cross-domain contracts consumed by a domain: define them in that domain's `ports/`
- Construction and adapter assembly for one domain: put them in that domain's `wiring/`
- Final CLI or server entrypoints that compose multiple domains: put them in `src/wiring/`

If a change needs a new directory name or a new cross-domain shortcut, stop and update the harness docs and checks first.

## Known Debt

The current no-new-violations baseline is tracked in `test/structure/baselines/architecture-findings.json`.

As of 2026-03-17, the remaining structural debt is concentrated in `src/orchestration/wiring/*`.
Those files still import concrete `conversation/*`, `permission/*`, and one `tool/wiring/*` path directly instead of crossing domain boundaries only through ports.

Those imports are tolerated only because they are recorded as baseline debt.
New violations outside that baseline should fail the structure checks immediately.
