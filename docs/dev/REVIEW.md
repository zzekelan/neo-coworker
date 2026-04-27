# REVIEW

This file defines the repository-local review harness for the coding and review agent working in this repo.
It tells the agent how to review changes here. It does not replace `docs/ARCHITECTURE.md` or `docs/dev/QUALITY_INVARIANTS.md`.

## Start Here

For review work in this repository, read in this order:

1. `docs/ARCHITECTURE.md`
2. `docs/dev/QUALITY_INVARIANTS.md`
3. this file

Review the change against the source documents above instead of restating them from memory.

## Review Priorities

Keep findings first.

Prioritize, in order:

1. bugs, regressions, and broken operator behavior
2. boundary and contract violations
3. missing or weak tests for the changed risk
4. document drift against `docs/ARCHITECTURE.md`, `docs/dev/QUALITY_INVARIANTS.md`, or plans

Style comments are not findings unless they hide one of the risks above.

Existing baseline debt is not, by itself, a review finding.
Only call it out when the change adds to it, depends on it, or spreads it to a new place.

## Severity

Use these severity levels, from highest to lowest:

- `error`: likely bug, regression, contract break, or missing coverage for a high-risk path
- `warning`: material risk or design gap that is not yet proven broken
- `note`: low-severity issue, doc drift, or promotion candidate

## Required Review Lenses

Every substantive review should cover these areas:

- behavior risk: does the change break runtime behavior, operator behavior, or recovery paths?
- boundary risk: does it violate architecture, error mapping, or public contract expectations?
- test gap: is the changed risk covered by the right boundary-level test?
- doc drift: do `docs/ARCHITECTURE.md`, `docs/dev/QUALITY_INVARIANTS.md`, or plans now need updates?

## Valid Finding Format

A valid finding should make clear:

- severity
- the affected file or code location
- the concrete problem
- why it matters in this repo
- an applicable `ARCH-*` or `INV-*` id when one exists
- a remediation direction

The wording and exact structure are flexible.
What matters is that the reader can quickly see the problem, risk, and expected fix.

```text
1. [error] ARCH-CROSS-001 [src/wiring/main.ts:12]
   Outer-shell code bypasses src/model/index.ts and imports a domain internal file directly.
   Risk: this creates a new side door around the public module exit and weakens the structure ratchet.
   Fix: import the domain through src/model/index.ts or export the required API there first.
```

If no current `ARCH-*` or `INV-*` id fits, say so directly and treat the issue as a promotion candidate.

## Review Output Rules

- Findings should come before summary.
- Prefer concrete risks over abstract style commentary.
- Use whatever structure best communicates the review clearly and concisely.
- When relevant, distinguish pre-existing debt from new debt or new spread introduced by the change.

## Promotion Loop

Repeated review findings should be promoted instead of repeated forever.

Promote a finding when either of these is true:

- the same shape appears in multiple reviews
- one review finding later appears again as a bug, regression, or cleanup task

Promotion path:

1. If the rule is still judgment-heavy, add or refine a `review-required` invariant in `docs/dev/QUALITY_INVARIANTS.md`.
2. If the rule is static, low-ambiguity, and has clear remediation, promote it into a fast executable check such as `test/structure/**`.
3. If the rule depends on runtime or persistence semantics, promote it into a behavior test and, when stable, cite it from `docs/dev/QUALITY_INVARIANTS.md`.
4. After promotion, update this file to point reviewers at the new source of truth instead of duplicating the rule here.

## Reviewer Latitude

This file defines review priorities and floor constraints, not a rigid script.

- Do not force a finding when there is no real risk.
- Do not expand low-signal style commentary into blocking review output.
- Do not treat the example wording above as a required template.
- Use judgment about how much structure, explanation, and citation the review needs.
