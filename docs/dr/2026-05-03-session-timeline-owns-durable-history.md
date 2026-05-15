---
status: accepted
---

# Session Timeline owns durable content history

Neo Coworker treats the **Session Timeline** as the durable, replayable content history of a session. A **Run** is an execution lifecycle that may produce timeline entries, but it does not own the timeline; this keeps persisted content history separate from execution status, permission suspension/resume, cancellation, replayable runtime notices, telemetry, and provider-specific model input.

## Considered Options

- **Run owns timeline**: matches parts of the current storage shape, but makes session history look fragmented by execution attempts and confuses lifecycle state with durable history.
- **Session Timeline owns timeline/content history**: matches how durable content is consumed, aligns with agent designs that separate history from run state, and makes model/UI projections explicit consumers of the timeline.
- **Part as top-level event log**: maximizes granularity, but would make UI grouping, model projection, and streaming assistant output more complex than the current entry/part shape requires.

## Consequences

- Use **Timeline Entry** and **Timeline Part** for persisted session content history; avoid naked “Message” as a domain term.
- Treat run references on timeline records as provenance/correlation, not ownership.
- Keep **Model Projection** and **UI Projection** separate: model-visible context is not the same as user-visible replay; **UI Projection** may also combine run state, permission state, and sanitized runtime notices.
- Treat **Compaction Entry** as the canonical term for compaction-generated history; persisted compaction-generated entries use the `compaction` role.
