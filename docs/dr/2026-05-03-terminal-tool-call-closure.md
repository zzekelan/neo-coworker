---
status: accepted
---

# Tool calls in the Session Timeline must be terminally closed

Neo Coworker treats a persisted tool-call **Timeline Part** as a provider-protocol obligation: it must eventually be closed by a terminal tool-result **Timeline Part** in the same assistant **Timeline Entry**. Normal tool failures, permission denials, malformed arguments, unknown tools, failed Run terminalization, and cancelled Run terminalization close the call as **Tool Result Errors**; the completed path instead asserts that all tool calls are already closed.

## Considered Options

- **Leave unresolved tool calls for projections to infer**: matches parts of the current implementation, but makes **Model Projection**, **UI Projection**, CLI rendering, compaction, and recovery logic interpret half-closed tool calls differently.
- **Skip unresolved tool calls only in Model Projection**: protects provider protocol but leaves other consumers of the **Session Timeline** inconsistent.
- **Terminally close persisted tool calls**: makes the **Session Timeline** explicit and lets projections consume one durable closure rule.

## Consequences

- Failed and cancelled terminal **Run** paths close unresolved tool calls before emitting the Run terminal signal.
- Cancellation closures use generic model-visible output and do not expose user-operation details, signal reasons, or internal abort errors by default.
- Legacy `kind="error"` tool closures may be read as compatibility, but new writes use canonical `tool_result` parts with `isError=true` and an `errorCode`.
- This DR captures the target domain rule; current implementation names such as message/part/timeline and legacy error parts may still exist until migrated.
