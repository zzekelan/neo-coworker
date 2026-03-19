# QUALITY_INVARIANTS

This file catalogs repo-specific invariants for the coding and review agent collaborating in this repository.
Architecture rules live in `docs/ARCHITECTURE.md`.
Quality invariants capture the stable naming, boundary, and reliability rules that are specific to this repo's failure modes.

Current blocking structure checks run through `bun run test:structure`.

## Enforcement Levels

- `blocking`: must pass in the fast structure suite
- `test`: enforced by targeted behavior tests
- `review-required`: stable rule, but still judged in review instead of mechanically blocked

## Invariants

### INV-STRUCTURE-001: Approved Domain Layer Names

- ID: `INV-STRUCTURE-001`
- Title: Approved Domain Layer Names
- Class: `architecture`
- Scope: `src/<domain>/**`
- Rule: Core domain code may only live under `types`, `config`, `repo`, `ports`, `service`, or `runtime`, plus a root `index.ts`. Domain-local `wiring/*` is tracked debt, not an approved target pattern for new code. Each domain root `index.ts` must stay a thin runtime facade (`index.ts -> runtime/*` only), and domain-internal files must not import their own root `index.ts`.
- Why this repo requires it: this repo depends on predictable directory roles and a single public exit per domain so a coding agent can navigate, place code, and obey import checks mechanically. Ad-hoc layer names or domain-local assembly layers hide intent and create new side doors around the architecture map.
- Enforcement: `blocking` via `bun run test:structure`
- Severity: `error`
- Bad example: `src/session/wiring/provider.ts`
- Good example: `src/session/service/run.ts`
- Remediation: move the file into an approved layer, add the missing root `index.ts` when a domain lacks one, or relocate true composition code into an outer-shell top-level. Update `docs/ARCHITECTURE.md`, this file, and the structure checks in the same change only if the architecture has genuinely changed.
- Source: `docs/ARCHITECTURE.md#domain-layers`, `docs/ARCHITECTURE.md#cross-domain-boundaries`, `docs/plans/2026-03-17-agent-collaboration-harness-design.md`

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

### INV-RELIABILITY-001: Scope-Bearing Config Values Preserve Semantics

- ID: `INV-RELIABILITY-001`
- Title: Scope-Bearing Config Values Preserve Semantics
- Class: `reliability`
- Scope: environment variables and adapter configuration that encode origin, path, workspace, or routing scope
- Rule: values such as URLs, paths, and workspace roots must preserve their scope semantics end to end or be rejected explicitly.
- Why this repo requires it: the same runtime is driven from CLI and server entrypoints. Silent path or URL truncation would make the collaborator harness act on the wrong workspace or origin.
- Enforcement: `test` plus `review-required`
- Severity: `error`
- Bad example: accepting `AGENT_SERVER_URL=http://host/prefix` and silently discarding `/prefix`
- Good example: `src/wiring/main.ts` rejects `AGENT_SERVER_URL` values that include path, query, or hash
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
