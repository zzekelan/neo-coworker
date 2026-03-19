# REVIEW

This file defines the repository-local review harness for the coding and review agent working in this repo.
It tells the agent how to review changes here. It does not replace `ARCHITECTURE.md` or `QUALITY_INVARIANTS.md`.

## Start Here

For review work in this repository, read in this order:

1. `ARCHITECTURE.md`
2. `QUALITY_INVARIANTS.md`
3. this file

Review the change against the source documents above instead of restating them from memory.

## Review Priorities

Order findings by severity and keep findings first.

Prioritize, in order:

1. bugs, regressions, and broken operator behavior
2. boundary and contract violations
3. missing or weak tests for the changed risk
4. document drift against `ARCHITECTURE.md`, `QUALITY_INVARIANTS.md`, plans, or task contracts
5. lower-signal maintainability concerns

Style comments are not findings unless they hide one of the risks above.

Existing baseline debt is not, by itself, a review finding.
Only call it out when the change adds to it, depends on it, or spreads it to a new place.

## Severity

Use these severity levels, from highest to lowest:

- `error`: likely bug, regression, contract break, or missing coverage for a high-risk path
- `warning`: material risk or design gap that is not yet proven broken
- `note`: low-severity issue, doc drift, or promotion candidate that should not block by itself

## Required Review Lenses

Every substantive review should explicitly check:

- behavior risk: does the change break runtime behavior, operator behavior, or recovery paths?
- boundary risk: does it violate architecture, error mapping, or public contract expectations?
- test gap: is the changed risk covered by the right boundary-level test?
- doc drift: do `ARCHITECTURE.md`, `QUALITY_INVARIANTS.md`, plans, or task contracts now need updates?

## Valid Finding Format

A valid finding must include:

- severity
- file and line reference
- the concrete problem
- why it matters in this repo
- an applicable `ARCH-*` or `INV-*` id when one exists
- a remediation direction

Preferred shape:

```text
1. [error] ARCH-CROSS-001 [src/wiring/main.ts:12]
   Outer-shell code bypasses src/model/index.ts and imports a domain internal file directly.
   Risk: this creates a new side door around the public module exit and weakens the structure ratchet.
   Fix: import the domain through src/model/index.ts or export the required API there first.
```

If no current `ARCH-*` or `INV-*` id fits, say so directly and treat the issue as a promotion candidate.

## Review Output Rules

- Findings first, sorted by severity.
- Keep each finding self-contained.
- Prefer concrete risks over abstract style commentary.
- If no findings remain, state that explicitly and mention residual risk or unverified areas.
- When relevant, distinguish:
  - pre-existing debt that the change did not worsen
  - new debt or new spread introduced by the change

## Promotion Loop

Repeated review findings should be promoted instead of repeated forever.

Promote a finding when either of these is true:

- the same shape appears in multiple reviews
- one review finding later appears again as a bug, regression, or cleanup task

Promotion path:

1. If the rule is still judgment-heavy, add or refine a `review-required` invariant in `QUALITY_INVARIANTS.md`.
2. If the rule is static, low-ambiguity, and has clear remediation, promote it into a fast executable check such as `test/structure/**`.
3. If the rule depends on runtime or persistence semantics, promote it into a behavior test and, when stable, cite it from `QUALITY_INVARIANTS.md`.
4. After promotion, update this file to point reviewers at the new source of truth instead of duplicating the rule here.

## Dry-Run Standard

When validating this harness on a recent change or fixture, confirm the review naturally produces:

- findings first
- severity ordering
- `ARCH-*` or `INV-*` citations when applicable
- explicit mention of test gaps or doc drift when they exist
