# ARCHITECTURE

This file is the structure map for the coding and review agent collaborating in this repository.
It describes how the repo is organized and where new code belongs.
It is not the behavioral source of truth for the runtime agent implemented under `src/`.

Behavioral details still live in the design and task-contract docs under `docs/plans/` and `docs/task_contract/`.

## Top-Level Map

Architecture ID: `ARCH-TOPLEVEL-001`

Approved top-level modules under `src/` fall into four groups:

- Capability modules:
  - `session`: durable session, run, message, and transcript state
  - `permission`: durable permission-request state and decision flow
  - `model`: model-provider integration and transcript projection
  - `tool`: tool catalog, execution, and tool-side runtime helpers
- Coordinator module:
  - `orchestration`: the agent loop, run progression, suspend/resume, streaming, and coordination through explicit capability ports
- Shell modules:
  - `bootstrap`: shared composition root and cross-module assembly
  - `cli`: CLI adapter and entrypoint
  - `app-server`: HTTP/SSE adapter and entrypoint
- Shared kernel:
  - `kernel`: truly global, stable, non-business contracts only

Transition-only legacy top-level names may still appear while the migration tasks are in flight:

- `conversation`: pre-rename durable-state module name, replaced by `session`
- `wiring`: pre-split outer-shell composition location, replaced by `bootstrap`, `cli`, and `app-server`
- `server`: pre-rename HTTP/SSE shell name, replaced by `app-server`

Legacy top-level directories such as `src/providers` and `src/runtime` are not allowed to reappear.

The current tree does not contain `src/kernel/` yet.
If a later change introduces it, it must start with `contracts/` plus a root `index.ts`; do not use it as a generic shared-types or shared-utils bucket.

The current tree also does not contain `src/utils/`.
If a later change needs a shared kernel, use `src/kernel/` narrowly and update the structure checks in the same change instead of introducing `src/utils/` implicitly.

## Module Layouts

Architecture ID: `ARCH-LAYER-001`

The old fixed six-layer template (`types / config / repo / ports / service / runtime`) is retired as the target architecture.
New code in this refactor must follow module-role-specific layouts instead.

### Capability Modules

`session`, `permission`, `model`, and `tool` are capability modules.

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

`orchestration/application/ports/` defines the capability contracts that `orchestration` needs from `session`, `permission`, `model`, and `tool`.

`orchestration` does not gain a mandatory `domain/` directory in this round.
If future work reveals durable, reusable orchestration-owned business rules that deserve a `domain/`, that must come from a later design change, not from ad hoc implementation drift.

### Shell Modules

`bootstrap`, `cli`, and `app-server` are shell modules.

Shell modules do not share a fixed subdirectory vocabulary in this round.
They own transport, adapter, entrypoint, and composition behavior according to their role:

- `bootstrap` owns cross-module assembly
- `cli` owns CLI transport behavior
- `app-server` owns HTTP and SSE transport behavior

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

Anything else is a layer violation.
In particular:

- `orchestration/application` must not import `session`, `permission`, `model`, or `tool`
- `orchestration/public` must not contain business logic or hidden side-effect initialization
- `orchestration` files must not import outer-shell code
- module-internal files must not import `src/orchestration/index.ts`

## Cross-Module Boundaries

Architecture ID: `ARCH-CROSS-001`

Cross-module imports are tightly constrained:

- capability modules may not import another capability module directly
- capability modules may not import `orchestration`
- `orchestration` may not import capability modules directly
- shell modules may import a capability or coordinator module only through `src/<module>/index.ts`
- capability modules, `orchestration`, and shell modules may import `kernel` only through `src/kernel/index.ts`
- `kernel` must not import capability modules, `orchestration`, or shell modules
- capability modules and `orchestration` must not depend on shell code
- `bootstrap` is the only approved place where multiple module APIs are wired together into a running application graph

The outer shell is not a loophole.
If composition needs another module's internals, the fix is to export a public capability from that module's `public/` layer and wire it together in `bootstrap`.

Positive examples:

- Target pattern: `src/bootstrap/runtime.ts -> src/orchestration/index.ts`
- Target pattern: `src/app-server/app.ts -> src/bootstrap/index.ts`

Negative examples:

- `src/app-server/app.ts -> src/session/repo/index.ts`
- `src/model/infrastructure/openai.ts -> src/tool/index.ts`
- `src/orchestration/application/run.ts -> src/session/index.ts`

The first example is current tracked debt.
The second and third examples are not legal patterns for new code.

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
- Is this the module's explicit public boundary, a stable factory or adapter meant for callers, or a light boundary projection over application contracts? Put it in `public/`.
- Is this a truly global, stable, non-business contract with no single-module owner? Put it in `kernel/contracts/`.
- Is this cross-module composition or application assembly? Put it in `bootstrap/`.
- Is this CLI transport behavior? Put it in `cli/`.
- Is this HTTP or SSE transport behavior? Put it in `app-server/`.

Defaults, constants, and policy values no longer go into a standalone `config/` layer.
They follow the owner that is responsible for interpreting them:

- business-semantic defaults and domain-owned constant sets go in `domain/`
- use-case policy defaults and application-owned strategy values go in `application/`
- adapter and implementation defaults go in `infrastructure/`
- deployment, entrypoint, and operator-environment defaults go in shell modules
- `kernel` never owns module defaults or strategy values

Migration mapping from the old structure should follow ownership, not directory-name equivalence:

- old `types/*` usually move to `domain/*` or `application/*`, depending on ownership
- old `config/*` usually move to `domain/*`, `application/*`, `infrastructure/*`, or a shell module, depending on who owns and interprets the value
- old `repo/contract.ts` usually becomes `application/ports/*`
- old `repo/*.ts` concrete storage implementations usually become `infrastructure/*`
- old `service/*` may split between `domain/*` and `application/*`
- old `runtime/api.ts` usually becomes `public/*`
- old runtime helper implementations such as queues, registries, provider adapters, and shell runners usually become `infrastructure/*`
- old module-local `wiring/*` is migration debt and should move to `bootstrap/*` or a final module-owned layer with clear ownership

If a change needs a new directory name, a new cross-module shortcut, or a broader `kernel`, stop and update the design docs and structure checks first.

## Transition Rules

The current `2026-03-19-session-bootstrap-app-server-debt-zero` worktree is migrating from the retired six-layer structure to the new module taxonomy.

During that migration:

- existing uses of `types/`, `config/`, `repo/`, `ports/`, `service/`, `runtime/`, and module-local `wiring/` may remain only as explicit tracked debt
- those retired names are not approved target patterns for new code
- missing target directories in not-yet-migrated modules are migration debt, not a reason to relax the target taxonomy
- shell modules must not add new deep imports into capability or coordinator internals, even while baseline debt still exists elsewhere
- the structure harness must distinguish:
  - legal target structure
  - temporary migration debt
  - forbidden new violations

The no-new-violations ratchet still applies throughout the migration.

## Known Debt

The current no-new-violations baseline is tracked in `test/structure/baselines/architecture-findings.json`.

As of 2026-03-21, the remaining migration debt includes:

- capability and coordinator modules still laid out under the retired six-layer directory vocabulary
- domain-local composition debt at `src/session/wiring/provider.ts`
- outer-shell imports in `src/app-server/*` that still reach into `src/session/{repo,service}/*` and `src/orchestration/runtime/stream.ts`

Those findings are tolerated only because they are recorded as migration debt in the structure baseline.
New occurrences of retired layer names, deep shell imports, or cross-module shortcuts outside that baseline should fail the structure checks immediately.
