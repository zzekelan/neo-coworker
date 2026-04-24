# Source Note Schema

Store source notes with these exact fields and order:

1. ID
2. Type
3. Title
4. URI/Path
5. Retrieved at
6. Reliability
7. Related findings
8. Excerpt
9. Notes

Valid records live under these paths:

```text
.ncoworker/research/<topic>/sources/web/W001-<slug>.md
.ncoworker/research/<topic>/sources/docs/D001-<slug>.md
.ncoworker/research/<topic>/sources/files/F001-<slug>.md
```

Allowed source types are web, docs, files.

Use short excerpts and avoid copying large raw source text.
