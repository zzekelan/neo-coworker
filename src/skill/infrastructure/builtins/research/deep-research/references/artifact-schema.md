# Research Artifact Schema

Canonical paths:

```text
.ncoworker/research/index.md
.ncoworker/research/<topic>/brief.md
.ncoworker/research/<topic>/findings.md
.ncoworker/research/<topic>/open-questions.md
.ncoworker/research/<topic>/sources/index.md
.ncoworker/research/<topic>/sources/web/W001-<slug>.md
.ncoworker/research/<topic>/sources/docs/D001-<slug>.md
.ncoworker/research/<topic>/sources/files/F001-<slug>.md
```

Topic brief fields, in order: Topic, Title, Summary, Status, Updated, Tags.

Finding fields, in order: Claim, Scope, Confidence, Verified at, Evidence, Notes.

Source fields, in order: ID, Type, Title, URI/Path, Retrieved at, Reliability, Related findings, Excerpt, Notes.

Allowed status values: active, stable, stale, archived.

Allowed confidence values: high, medium, low.

Allowed source types: web, docs, files.
