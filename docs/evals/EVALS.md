# EVALS

This document is the developer guide for the eval harness under `evals/`.
It explains when to use evals, how to run them, and the guardrails for adding or changing eval tasks.

It is not the design source of truth for runtime observability ownership.
That design still lives in [`docs/plans/2026-03-26-runtime-observability-and-eval-foundation-design.md`](../plans/2026-03-26-runtime-observability-and-eval-foundation-design.md).

## When To Read This

Read this file when:

- you need to run the eval harness locally
- you are changing files under `evals/`
- you are adding or changing eval tasks, fixtures, graders, or runner behavior
- you are debugging scripted vs live eval mode behavior
- a task asks for eval artifacts, eval output interpretation, or the `bun run eval` workflow

## What Evals Are For

The eval harness is a developer-facing system for running repo-defined tasks through the real runtime path and grading the exported artifacts.

Current goals:

- fast deterministic regression coverage through scripted provider scenarios
- opt-in validation of the real env-backed provider path through live mode
- artifact bundles that can be inspected without querying runtime memory directly
- graders that can verify transcript ordering, trace sequence, tool-result consumption, and skill disclosure

The eval harness is not an end-user feature.
Its artifacts and grader outputs are developer/operator material.

## Entry Point

The stable command entrypoint is:

```sh
bun run eval
```

The script is declared in [`package.json`](../../package.json).

## Provider Modes

### `scripted`

`scripted` is the default mode.
It is the fast regression lane and should stay suitable for normal local development.

Use it for:

- routine regression checks
- task and grader development
- fixture and artifact debugging

### `live`

`live` is opt-in.
It uses the same env-backed default provider assembly path as CLI and server.

Use it for:

- validating the real provider integration
- checking that env parsing and default provider wiring still work end to end
- smoke testing live traces and artifact export

Do not make live mode part of the default fast loop.

## Common Commands

List scripted tasks:

```sh
bun run eval --list
```

List live tasks:

```sh
bun run eval --list --mode live
```

Run the default scripted suite:

```sh
bun run eval
```

Run one scripted task:

```sh
bun run eval --task regression/read-only
```

Run one live task:

```sh
bun run eval --mode live --task live/read-only
```

Write artifacts to a custom directory:

```sh
bun run eval --output-root /tmp/evals
```

## Live Mode Setup

Live mode reads the same provider env as the runtime shell.

Required variables:

- `LLM_PROVIDER`
- `LLM_API_KEY`

Additional requirements:

- `LLM_MODEL` is required for `LLM_PROVIDER=openai-compatible`
- `LLM_BASE_URL` is required for `LLM_PROVIDER=openai-compatible`
- `SEARCH_BACKEND_URL` is optional; when absent, `websearch` and `codesearch` fall back to the built-in public search backend

Example:

```sh
LLM_PROVIDER=openai \
LLM_API_KEY=... \
LLM_MODEL=gpt-5 \
bun run eval --mode live --task live/read-only
```

Eval artifacts must not store raw secrets such as API keys.

## Artifact Output

By default eval output is written under:

```text
.ncoworker/evals/<timestamp>/<task-id>/
```

Legacy `.agents/evals` directories are ignored; the default output root does not
fall back when old artifact state is present.

Each task artifact bundle currently contains:

- `trace.json`
- `runs.json`
- `transcript.json`
- `outcome.json`
- `metrics.json`
- `grader-results.json`

The CLI summary also prints:

- task id
- provider mode
- provider kind
- provider model when available
- terminal run status
- grader pass/fail state
- failure summary when present
- artifact directory

## Task Layout

Current task directories:

- `evals/tasks/regression/`
- `evals/tasks/live/`

Current fixture root:

- `evals/fixtures/`

Current runner and grading code:

- `evals/runners/`
- `evals/graders/`
- `evals/schemas/`

Current richer task fields:

- `sessionSeed.activeSkills` for seeding run snapshots from session defaults
- `contextWindow` for forcing a smaller runtime context window during a task
- `steps` for multi-run session scripts such as prompt → command → prompt flows
- `providerFaults.summarizeFailures` for deterministically faulting the next N compaction summarize turns inside the eval harness
- `transcriptExpectation` for transcript ordering and structured checkpoints
- `traceSequenceExpectation` for ordered trace assertions
- `traceDataExpectation` for checking trace payload fields on the final run or an earlier run by index
- `toolConsumptionExpectation` for verifying assistant follow-up after tool results
- `skillDisclosureExpectation` for proving progressive disclosure around activation
- `promptAssemblyExpectation` for checking prompt state before and after activation
- `runRecordsExpectation` for checking per-run trigger/status/token accounting across multi-step tasks

## Rules For Adding Tasks

When adding or changing eval tasks:

- keep default local coverage in `scripted` mode
- keep `live` tasks opt-in and resilient to normal model variability
- when a live task needs deterministic compaction-failure coverage, prefer `providerFaults.summarizeFailures` over brittle prompt tricks
- prefer structured expectations such as run status, protocol, tool policy, and trace completeness
- prefer the richer structured expectations over brittle exact free-text assertions whenever possible
- avoid exact free-text grading in live mode unless variability is tightly controlled
- keep `workspaceFixture` inside `evals/fixtures`
- keep scripted tasks paired with a `scenario`
- keep `.ncoworker/skills` fixture content minimal and commit ignored skill files explicitly when a live skill task needs them; use `.agents/skills` only for explicit legacy-removal coverage that proves old skills are ignored
- do not place secrets in tasks, fixtures, or exported artifacts

## Where To Look Next

For implementation details:

- [`evals/main.ts`](../../evals/main.ts)
- [`evals/runners/direct.ts`](../../evals/runners/direct.ts)
- [`evals/runner.ts`](../../evals/runner.ts)

For design rationale:

- [`docs/plans/2026-03-26-runtime-observability-and-eval-foundation-design.md`](../plans/2026-03-26-runtime-observability-and-eval-foundation-design.md)
