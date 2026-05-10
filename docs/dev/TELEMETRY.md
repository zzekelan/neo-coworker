# TELEMETRY

This document explains the current developer-facing telemetry and runtime observability surface in this repository.
It is a practical guide for inspection, debugging, and iteration.


## Scope

In this repo, telemetry means the runtime signals emitted while a run executes and the durable artifacts derived from those signals.

Current first-wave telemetry is centered on:

- append-only `run_event` records
- per-run trace export
- small derived metrics used by the eval harness

This is enough for repo-local debugging and regression iteration.
It is not a full external observability stack.

## What Exists Today

The runtime has a dedicated `observability` capability module under [`src/observability`](../../src/observability).
That module records runtime signals from the rest of the system and persists them as ordered `run_event` rows.

Current producer categories are:

- orchestration lifecycle events
- model observer events
- tool observer events
- permission observer events

The durable unit is one run.
One run exports as one trace.

## Telemetry vs Timeline Content

Do not treat Timeline content, transcript compatibility projections, and telemetry as the same thing.

`session` owns the durable Session Timeline.
Timeline entries are the content history used for replay and runtime context.

Transcript-shaped data is a compatibility projection over the Session Timeline.
Use it only when an existing consumer still needs the older transcript contract.

`observability` owns telemetry.
Telemetry answers how the run executed, where it stalled, what retried, and what terminal path was taken.

Use Timeline content when you need conversation content.
Use telemetry when you need runtime behavior.

## Durable Record Shape

The first-wave durable record is `run_event`.
The SQLite implementation lives in [`src/observability/infrastructure/sqlite.ts`](../../src/observability/infrastructure/sqlite.ts).

The important persisted fields are:

- `session_id`
- `run_id`
- `sequence`
- `event_type`
- `payload_json`
- `created_at`

Ordering is durable through `sequence`.
Do not infer business order from random ids or timestamp ties.

## Export Surface

The runtime exports one trace per run.
The export API lives in [`src/observability/application/runtime-api.ts`](../../src/observability/application/runtime-api.ts).

Current stable operator/developer-facing export path:

- HTTP `GET /runs/:runId/trace`

That endpoint is wired through:

- [`src/app-server/server.ts`](../../src/app-server/server.ts)
- [`src/bootstrap/server-app.ts`](../../src/bootstrap/server-app.ts)
- [`src/bootstrap/server.ts`](../../src/bootstrap/server.ts)

The exported trace is intended for debugging, inspection, and eval consumption.
It is not an ordinary end-user API surface.

## What A Trace Tells You

A trace lets you answer questions like:

- did the run start and terminate cleanly
- did the model request retry before succeeding or failing
- did the run wait on permission
- which tool calls completed
- whether the run completed, failed, or was cancelled

Typical event families you will see:

- `run.started`
- `model.turn.requested`
- `model.turn.retrying`
- `permission.requested`
- `permission.resolved`
- `tool.call.completed`
- `run.completed`
- `run.failed`
- `run.cancelled`

Exact event coverage depends on the run path.

## Contract Events For Deep Research MVP

The repository also exposes exact contract event names for upcoming path, skill, agent, and research workflows.
These names intentionally use snake_case to match the plan contract and do not replace existing dotted events such as `skill.activated`.

- `app_state_path_resolved` records safe metadata about resolved config/data/app-state roots without absolute paths or secrets.
- `builtin_skill_materialized` records safe metadata for materialized built-in skill packages.
- `skill_activated` records safe metadata for contract-level skill activation events.
- `agent_switched` records safe metadata when the active agent changes.
- `deep_research_subagents_planned` records topic slug, planned count, and subagent kinds without prompts or private content.
- `research_artifact_written` records topic slug, artifact kind, and workspace-relative `.ncoworker/research/**` path without artifact body, excerpts, or private file contents.

## Where Telemetry Is Wired

Cross-cutting observability wiring is assembled in `bootstrap`.
Important entrypoints:

- [`src/bootstrap/runtime.ts`](../../src/bootstrap/runtime.ts)
- [`src/bootstrap/server.ts`](../../src/bootstrap/server.ts)
- [`src/cli/main.ts`](../../src/cli/main.ts)

The rule for this design wave is that `observability` remains the single implementation owner of these cross-cutting recording paths.
Other modules may define the narrow observer ports they need, but should not grow parallel trace stores or export implementations.

## Using Telemetry For Iteration

The current intended loop is:

1. run the runtime through CLI, server, or `evals`
2. inspect the trace for the target run
3. identify runtime-path problems such as missing events, bad terminal state, permission stalls, or retries
4. add or tighten tests and graders around the observed failure
5. rerun the scripted or live eval task

For eval usage details, read [`docs/evals/EVALS.md`](../evals/EVALS.md).

## Evals Integration

The eval harness does not query runtime memory directly.
It consumes exported artifacts.

The relevant path is:

- runtime produces `run_event`
- observability exports a per-run trace
- [`evals/runner.ts`](../../evals/runner.ts) packages `timeline`, transcript compatibility, `trace`, `outcome`, and `metrics`
- graders under [`evals/graders`](../../evals/graders) inspect those artifacts

This keeps runtime telemetry and developer eval infrastructure separate while still forming one debugging loop.
Content graders should inspect the Timeline content artifact, falling back to transcript compatibility only for older artifacts.
Execution-behavior graders should inspect trace artifacts.

## Current Limits

Current telemetry does not provide:

- OTLP export
- Jaeger or Tempo integration
- Prometheus metrics scraping
- alerting or dashboards
- a full span tree with parent-child timing semantics

If you need those, treat them as future observability work rather than assuming they already exist.

## Tests To Read

If you are changing telemetry behavior, start with these tests:

- [`test/runtime/observability.test.ts`](../../test/runtime/observability.test.ts)
- [`test/observability/runtime-api.test.ts`](../../test/observability/runtime-api.test.ts)
- [`test/observability/sqlite.test.ts`](../../test/observability/sqlite.test.ts)
- [`test/server/http-api-and-sse.test.ts`](../../test/server/http-api-and-sse.test.ts)
- [`test/server/recovery-and-operator.test.ts`](../../test/server/recovery-and-operator.test.ts)

If you are changing the eval loop that consumes telemetry, also read:

- [`test/evals/runner.test.ts`](../../test/evals/runner.test.ts)
- [`test/evals/direct-runner.test.ts`](../../test/evals/direct-runner.test.ts)
- [`test/evals/main.test.ts`](../../test/evals/main.test.ts)
