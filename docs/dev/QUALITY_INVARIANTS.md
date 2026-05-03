# QUALITY_INVARIANTS

This file catalogs repo-specific invariants for the coding and review agent collaborating in this repository.
Architecture rules live in `docs/ARCHITECTURE.md`.
Quality invariants capture the stable naming, boundary, and reliability rules that are specific to this repo's failure modes.

Current blocking structure checks run through `bun run test:structure`.
The blocking structure suite now enforces the final architecture directly, with an expected empty baseline.

## Enforcement Levels

- `blocking`: must pass in the fast structure suite
- `test`: enforced by targeted behavior tests
- `review-required`: stable rule, but still judged in review instead of mechanically blocked

## Invariants

### INV-STRUCTURE-001: Approved Module Role Layouts

- ID: `INV-STRUCTURE-001`
- Title: Approved Module Role Layouts
- Class: `architecture`
- Scope: `src/**`
- Rule: `observability`, `session`, `permission`, `model`, `skill`, and `tool` are capability modules and may only target `public`, `application`, `domain`, and `infrastructure`, plus a root `index.ts`. `orchestration` is a coordinator module and may only target `public`, `application`, and `infrastructure`, plus a root `index.ts`. `application/ports/` is optional and means outbound dependency contracts only. `kernel` may only target `contracts/` plus a root `index.ts`. Infrastructure may contain semantically-owned subroles such as `adapters`, `runtime`, or module-specific technical subroles like `builtins`, but modules are not forced to create a fixed infrastructure template. Retired directories such as `types`, `config`, `repo`, `ports`, `service`, `runtime`, and module-local `wiring` are forbidden target patterns for code in this architecture. Defaults and policy values follow semantic owner placement instead of a standalone `config/` layer.
- Why this repo requires it: this repo depends on predictable module roles so a coding agent can place code, infer ownership, and obey import checks mechanically. Reusing the old six-layer template as a fallback would keep public boundaries muddy and recreate the ladder-export pressure this refactor is removing.
- Enforcement: `blocking` via `bun run test:structure`
- Severity: `error`
- Bad example: `src/session/wiring/provider.ts`
- Good example: a migrated capability-module file such as `src/session/application/start-run.ts`
- Remediation: move the file into the approved layout for its module role, place defaults and policies with their semantic owner, and remove retired directories from live module structures.
- Source: `docs/ARCHITECTURE.md#top-level-map`, `docs/ARCHITECTURE.md#module-layouts`, `docs/ARCHITECTURE.md#placement-guide`, `docs/plans/2026-03-21-module-boundary-reframe-design.md`, `docs/plans/2026-03-22-infrastructure-semantics-reframe-design.md`

### INV-STRUCTURE-002: Shared Kernel Stays Narrow

- ID: `INV-STRUCTURE-002`
- Title: Shared Kernel Stays Narrow
- Class: `architecture`
- Scope: `src/kernel/**`
- Rule: `kernel` may expose only truly global, stable, non-business contracts under `contracts/` and its root `index.ts`. It must not become a shared-types bucket for module-owned business types, runtime events, defaults, or policies.
- Why this repo requires it: once a generic shared bucket appears, ownership erodes quickly and capability boundaries stop being mechanically enforceable. The shared kernel is allowed only as a narrow exception for contracts that genuinely have no single-module owner.
- Enforcement: `blocking` via `bun run test:structure`
- Severity: `error`
- Bad example: `src/kernel/contracts/run-status.ts`
- Good example: `src/kernel/contracts/clock.ts`
- Remediation: move module-owned concepts back into the owning capability or coordinator module and keep `kernel` limited to small global contracts.
- Source: `docs/ARCHITECTURE.md#top-level-map`, `docs/ARCHITECTURE.md#module-layouts`, `docs/plans/2026-03-21-module-boundary-reframe-design.md`

### INV-BOUNDARY-001: Public Adapters Map Explicit Errors

- ID: `INV-BOUNDARY-001`
- Title: Public Adapters Map Explicit Errors
- Class: `boundary`
- Scope: CLI, HTTP, SSE, and other operator-facing adapters
- Rule: public adapters must map domain, runtime, and storage failures into explicit transport or operator-facing errors instead of leaking generic exceptions.
- Why this repo requires it: this repo exposes the same orchestration behavior through multiple adapters. If one adapter leaks raw errors, agents and operators lose a stable contract and recovery becomes adapter-specific.
- Enforcement: `test` plus `review-required`
- Severity: `error`
- Bad example: letting a repository exception escape directly from an HTTP handler as a generic 500 without a stable error code
- Good example: `test/server/http-api-and-sse.test.ts` exercises stable transport error mapping at the HTTP boundary
- Remediation: classify the failure at the adapter boundary and map it to the adapter contract before the error crosses the transport.
- Source: `docs/project-rules/coworker-coding-rules.md` rule 7, `test/server/http-api-and-sse.test.ts`

### INV-BOUNDARY-002: Public Module Exits And Composition Stay Explicit

- ID: `INV-BOUNDARY-002`
- Title: Public Module Exits And Composition Stay Explicit
- Class: `boundary`
- Scope: module root exports, shell imports, and cross-module composition
- Rule: root `index.ts` is the single public module exit. Capability and coordinator roots re-export only from `public/`, and `kernel` re-exports only from `contracts/`. `public/` is the module-owned public boundary layer and may expose application contracts plus stable infrastructure-backed factories or adapters that are intentionally public. Compatibility bridge barrels such as `public.ts`, `compat.ts`, and multi-hop re-export ladders are forbidden. `bootstrap` may import capability and coordinator modules only through `src/<module>/index.ts`; non-`bootstrap` shell modules such as `cli`, `app-server`, and `desktop` may import only `src/bootstrap/index.ts` and `src/kernel/index.ts` across module boundaries.
- Why this repo requires it: this repo is refactoring toward explicit module boundaries. If public exports leak through internal ladders or shell code keeps reaching into internals, the module taxonomy becomes nominal only and later tasks cannot tighten the structure suite without blocking on new ambiguity.
- Enforcement: `blocking` via `bun run test:structure`
- Severity: `error`
- Bad example: `src/app-server/app.ts` importing `src/session/repo/index.ts`
- Good example: `src/bootstrap/runtime.ts` importing `src/orchestration/index.ts`
- Remediation: publish the needed capability through the target module's `public/`, import it in `bootstrap` through its root `index.ts`, and keep non-`bootstrap` shells dependent on `src/bootstrap/index.ts` plus `src/kernel/index.ts` only.
- Source: `docs/ARCHITECTURE.md#cross-module-boundaries`, `docs/ARCHITECTURE.md#public-export-contract`, `docs/plans/2026-03-21-module-boundary-reframe-design.md`

### INV-BOUNDARY-003: Adapter Subroles Depend On Precise Ports

- ID: `INV-BOUNDARY-003`
- Title: Adapter Subroles Depend On Precise Ports
- Class: `architecture`
- Scope: `src/**/infrastructure/adapters/**/*`
- Rule: files under `infrastructure/adapters/` implement precise application-owned outbound dependency contracts. They may depend on `application/ports/*`, necessary module-owned `domain/*` contracts, `src/kernel/index.ts`, same-layer infrastructure helpers, and external/platform APIs. They must not depend directly on application workflows, mixed application barrels, or public-boundary files.
- Why this repo requires it: this repo uses `infrastructure` for both strict adapters and runtime machinery. Without a stricter rule for true adapters, mixed application barrels become catch-all contract sources and later migrations cannot make semantic ownership mechanical.
- Enforcement: `blocking` via `bun run test:structure` for direct application-workflow imports, plus `review-required` for helper semantics that are too transitive for a cheap structure check.
- Severity: `error`
- Bad example: `src/model/infrastructure/adapters/openai.ts` importing `../application/runtime-api`
- Good example: `src/model/infrastructure/adapters/openai.ts` importing `../application/ports/provider`
- Remediation: define or use a precise application port, keep runtime assembly outside the adapter file, and stop routing adapter contracts through mixed application barrels.
- Source: `docs/ARCHITECTURE.md#module-layouts`, `docs/ARCHITECTURE.md#internal-module-boundaries`, `docs/plans/2026-03-22-infrastructure-semantics-reframe-design.md`

### INV-BOUNDARY-004: Runtime Machinery Contracts Stay With Runtime Owners

- ID: `INV-BOUNDARY-004`
- Title: Runtime Machinery Contracts Stay With Runtime Owners
- Class: `architecture`
- Scope: `src/**/application/**`, `src/**/infrastructure/runtime/**`
- Rule: machinery-only contracts such as queue handles, active registries, pending maps, suspension controllers, and loop-driver inputs belong with the owning `infrastructure/runtime/` machinery rather than in `application`. `application` keeps use-case semantics, policies, ports, and application-owned handles/contracts.
- Why this repo requires it: the current failure mode in this repo is not only illegal import direction; it is mixed ownership inside legal directions. If machinery contracts stay in `application`, files like `application/runtime-api.ts` keep turning into catch-all barrels and later boundary tightening cannot stay stable.
- Enforcement: `review-required`
- Severity: `error`
- Bad example: `src/orchestration/application/runtime-api.ts` exporting active-run registry or suspension machinery contracts
- Good example: `src/orchestration/infrastructure/runtime/active-run-registry.ts`
- Remediation: move the contract next to the runtime machinery that owns it, or define a smaller application-owned contract if application semantics genuinely need a stable handle.
- Source: `docs/ARCHITECTURE.md#module-layouts`, `docs/ARCHITECTURE.md#internal-module-boundaries`, `docs/plans/2026-03-22-infrastructure-semantics-reframe-design.md`

### INV-BOUNDARY-005: App Clients Preserve App Server Semantics

- ID: `INV-BOUNDARY-005`
- Title: App Clients Preserve App Server Semantics
- Class: `boundary`
- Scope: `src/cli/**`, `src/desktop/**`, `src/app-server/**`, and App Server client adapters
- Rule: CLI and Desktop are App Clients. They must drive Session, Run, Transcript, Permission Request, Permission Decision, and event behavior through the App Server boundary. A local CLI path may use an in-process App Server adapter, but it must preserve the same request, event, permission, transcript, and run lifecycle semantics as the HTTP/SSE App Server path. Client surface belongs in Client Source, not Run Trigger.
- Why this repo requires it: the project is moving toward a headless-server design. If CLI grows a parallel runtime model, then stored runs, transcript replay, permission handling, and Desktop behavior will diverge around the hardest product concepts.
- Enforcement: `test` plus `review-required`
- Severity: `error`
- Bad example: adding a CLI-only run lifecycle that writes transcript parts, permission state, or run status without going through the App Server semantic contract
- Good example: a CLI command using the same App Server client contract as the HTTP/SSE client, with any in-process adapter delegated to `bootstrap`
- Remediation: route the behavior through the App Server client contract, or move the shared semantic operation into the App Server application contract assembled by `bootstrap`.
- Source: `docs/CONTEXT.md`, `docs/ARCHITECTURE.md#shell-modules`

### INV-RELIABILITY-001: Scope-Bearing Config Values Preserve Semantics

- ID: `INV-RELIABILITY-001`
- Title: Scope-Bearing Config Values Preserve Semantics
- Class: `reliability`
- Scope: environment variables and adapter configuration that encode origin, path, workspace, or routing scope
- Rule: values such as URLs, paths, and workspace roots must preserve their scope semantics end to end or be rejected explicitly.
- Why this repo requires it: the same runtime is driven from CLI and server entrypoints. Silent path or URL truncation would make the collaborator harness act on the wrong workspace or origin.
- Enforcement: `test` plus `review-required`
- Severity: `error`
- Bad example: accepting `NCOWORKER_SERVER_URL=http://host/prefix` and silently discarding `/prefix`
- Good example: `src/bootstrap/provider.ts` rejects `NCOWORKER_SERVER_URL` values that include path, query, or hash; `AGENT_SERVER_URL` remains a legacy fallback
- Remediation: either carry the scope-bearing value through the full contract or fail fast with an explicit setup error.
- Source: `docs/project-rules/coworker-coding-rules.md` rule 8, `test/server/server-main.test.ts`

### INV-RELIABILITY-002: Repeatable Control Commands Stay Idempotent

- ID: `INV-RELIABILITY-002`
- Title: Repeatable Control Commands Stay Idempotent
- Class: `reliability`
- Scope: cancel, permission reply, and other control commands that users or transports may repeat
- Rule: repeated control commands must be idempotent at the adapter boundary or must classify duplicate terminal-state failures explicitly.
- Why this repo requires it: permission replies, cancel requests, and server restarts can race with live orchestration. Duplicate control handling must stay predictable or operators will retrigger work unintentionally.
- Enforcement: `test` plus `review-required`
- Severity: `error`
- Bad example: firing a duplicate permission approval and letting the second call execute the side effect again
- Good example: `test/runtime/permission-flow.test.ts` covers duplicate approval and stale replies explicitly
- Remediation: make the public control path idempotent or convert duplicate terminal-state failures into a stable contract error.
- Source: `docs/project-rules/coworker-coding-rules.md` rule 9, `test/runtime/permission-flow.test.ts`, `test/cli/run-command.test.ts`
