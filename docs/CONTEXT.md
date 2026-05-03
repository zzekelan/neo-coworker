# Neo Coworker

Neo Coworker is an agent runtime for long-running coding sessions, where durable session content history is kept separate from execution lifecycle state, replayable runtime notices, and provider-specific model input.

## Language

**Session**:
A long-lived agent workspace that contains the durable content history and replayable runtime context for a user’s coding task.
_Avoid_: Run, Turn

**Session Timeline**:
The durable, replayable content history of a **Session**; "Transcript" is a legacy/API-facing alias, not the canonical domain term.
_Avoid_: Run history, execution log, Transcript as the canonical term

**Timeline Entry**:
An ordered item in a **Session Timeline** that may be produced by a **Run**.
_Avoid_: naked Message, Run message, Timeline Item

**Timeline Part**:
A typed content block inside a **Timeline Entry**; tool results are parts in domain history even when projected as tool-role model messages.
_Avoid_: top-level timeline item, standalone history item, provider role as domain role

**Tool Result Error**:
A tool-result **Timeline Part** that records a failed, denied, malformed, or otherwise unsuccessful tool call so the tool-call protocol is closed for **Model Projection**.
_Avoid_: provider failure, generic runtime error, compaction notice, assistant error text

**Produced By Run**:
The provenance relationship from a **Timeline Entry** or **Timeline Part** to the **Run** that produced it.
_Avoid_: source Run, parent Run, Run ownership

**Run**:
An execution lifecycle that may produce **Timeline Entries** while it moves through states such as running, waiting, completed, failed, or cancelled.
_Avoid_: Turn, Transcript owner, history owner, conversation turn

**Sub-session**:
A child **Session** created to isolate sub-agent work from its parent **Session**.
_Avoid_: Fork, branch

**Spawned Run**:
A **Run** in a **Sub-session** that was started by a parent **Run** in another **Session**.
_Avoid_: child Run owned by parent Run

**Model Projection**:
A temporary transformation from a **Session Timeline** into provider-facing model input.
_Avoid_: canonical history, stored transcript

**Model Message**:
A provider-facing message produced by **Model Projection** for an LLM request.
_Avoid_: Timeline Entry, durable history item

**UI Projection**:
A transformation from a **Session Timeline** into user-facing views such as desktop chat or CLI replay.
_Avoid_: Model Projection, provider context

**Compaction Entry**:
A system-generated **Timeline Entry** that records a compaction boundary or compaction summary.
_Avoid_: Synthetic Timeline Entry as the canonical term, ordinary runtime event, hidden user input, provider system prompt, assistant output, generic synthetic event, compaction notice

**Compaction Boundary**:
A **Timeline Part** that marks where **Model Projection** resumes replay after compaction.
_Avoid_: user-visible message text, model-visible content

**Compaction Summary**:
Text in a **Compaction Entry** that replaces older **Session Timeline** content during **Model Projection**.
_Avoid_: full transcript copy, UI notification

**Runtime Notice**:
A sanitized, replayable, user-facing runtime fact that **UI Projection** may display alongside the **Session Timeline** without making it timeline content or model context.
_Avoid_: Timeline Entry, Model Message, raw observability event, assistant output

**Compaction Notice**:
A **Runtime Notice** about compaction lifecycle that affects user understanding or follow-up action, such as manual compaction failure or automatic compaction being paused.
_Avoid_: Compaction Entry, Compaction Summary, ordinary transient compaction retry, model context, assistant output

**Compaction Run**:
A **Run** that represents the lifecycle of a user-requested compaction operation.
_Avoid_: generic command Run, hidden summary Run as canonical compaction lifecycle

**Permission Request**:
A request for user approval before a risky action continues.
_Avoid_: Timeline Entry, chat message

## Relationships

- A **Session** owns exactly one **Session Timeline**.
- A **Session Timeline** contains zero or more session-ordered **Timeline Entries**.
- A **Timeline Entry** contains zero or more ordered **Timeline Parts**.
- **Timeline Entry** ordering is owned by the **Session Timeline**, not by **Runs**.
- A **Timeline Part** is ordered only within its parent **Timeline Entry**.
- `callId` is a required tool-call protocol correlation id that pairs tool-call and tool-result **Timeline Parts**; it is not timeline ordering or ownership.
- A tool result is a **Timeline Part** in domain history.
- A **Run** belongs to exactly one **Session**.
- A **Run** may produce zero or more **Timeline Entries**, including multiple assistant **Timeline Entries** across repeated model/tool steps.
- A **Run** is not a **Timeline Entry**.
- A **Timeline Entry** may record **Produced By Run** provenance, but is not owned by the **Run**.
- A **Timeline Part** inherits **Produced By Run** provenance from its parent **Timeline Entry** unless a future use case explicitly requires otherwise.
- A **Sub-session** belongs to exactly one parent **Session**.
- A **Spawned Run** belongs to its own **Sub-session**, not to the parent **Run** that started it.
- A parent **Run** may spawn zero or more **Spawned Runs** in **Sub-sessions**.
- **Model Projection** reads a **Session Timeline** and produces zero or more **Model Messages**.
- A **Model Message** is not part of the **Session Timeline**.
- **UI Projection** may combine the **Session Timeline**, **Run** lifecycle state, **Permission Request** state, **Runtime Notices**, and context usage into user-facing views.
- Whether a **Timeline Part** appears in **UI Projection** is independent from whether it appears in **Model Projection**.
- Runtime-only **Timeline Parts** may appear in **UI Projection** but are excluded from **Model Projection** unless required by provider protocol.
- `waiting_permission` is **Run** lifecycle state, not timeline content.
- A **Permission Request** is independent permission state, not a **Timeline Entry**.
- **Tool Result Errors** are model-visible only because provider tool-call protocol requires every tool call to be closed.
- The canonical storage shape for a **Tool Result Error** is a tool-result **Timeline Part** with an error status such as `isError=true`; legacy `kind="error"` tool records are compatibility details to migrate away from.
- A **Tool Result Error** closes a tool call in the same assistant **Timeline Entry** whenever possible, preserving entry-local tool-call/tool-result grouping.
- Terminal closure tool-result parts are appended to the containing **Timeline Entry** using the next part sequence; existing parts are not reordered, and pairing relies on Produced By Run plus `callId` rather than adjacency.
- When terminalization closes multiple unresolved tool calls in the same **Timeline Entry**, closure tool results are appended in the original tool-call part sequence order.
- If parallel tool calls are partially completed when a **Run** fails or is cancelled, terminalization closes only the unresolved calls and leaves already closed tool calls unchanged.
- Terminalization-created tool-call closures emit the same terminal tool-call runtime signal as ordinary tool results, with `isError=true` and closure metadata such as error code.
- Terminalization-created tool-call closure signals are emitted before the **Run** terminal signal so the terminal **Run** event represents a fully closed execution lifecycle.
- When closing multiple unresolved tool calls in one **Timeline Entry**, append closures in the original tool-call part sequence order.
- Terminalization must not synthesize fallback call ids or tool names; a persisted tool-call **Timeline Part** without `callId` or `toolName` is malformed timeline data and an invariant violation, handled by bug fix or repair rather than normal closure.
- A **Tool Result Error** stores stable tool-result data including `callId`, `toolName`, `isError: true`, `errorCode`, and `output`; optional details such as allowed tools, permission request id, or run failure text belong in metadata.
- Permission requests and decisions are not timeline content, but a denied tool call may produce a **Tool Result Error** to close the tool-call protocol.
- A permission-denied tool-call closure is a **Tool Result Error**, stored as a tool-result **Timeline Part** with an error status, while the **Permission Request** and decision remain separate permission state.
- Malformed tool arguments are **Tool Result Errors** because an emitted tool call must still be closed for provider protocol correctness.
- Unknown tool calls are **Tool Result Errors** because an emitted tool call must still be closed and the model may need recoverable feedback about available tools.
- Tool execution failures are **Tool Result Errors** because an emitted tool call must be closed with the failed execution result.
- Every persisted tool-call **Timeline Part** must eventually be closed by a terminal tool-result **Timeline Part**.
- Cancellation or abort after a tool call has been persisted closes the call as a **Tool Result Error** with a cancellation reason.
- Before a **Run** completes, all persisted tool-call **Timeline Parts** produced by that **Run** must already be terminally closed by tool-result **Timeline Parts**; an unresolved tool call on the completed path is a runtime invariant violation, not a normal recovery branch or automatic closure case.
- If a **Run** fails or is cancelled after persisting unresolved tool calls, those calls are closed as **Tool Result Errors** with run-failed or cancellation reasons.
- If completion detects unresolved tool calls and fails with an invariant violation, the subsequent failed terminalization may close those calls as run-failed **Tool Result Errors**.
- A run-failed tool-call closure uses a generic model-visible output such as "Run failed before this tool call completed."; raw failure details remain in **Run** state, trace, or metadata rather than default model-visible output.
- Cancellation and abort tool-call closures are canonicalized as cancellation closures with generic model-visible output such as "Run was cancelled before this tool call completed."; user-operation details, signal reasons, and internal abort errors are not default model-visible output.
- Tool-call closure is an orchestration terminalization responsibility: terminal **Run** paths must enforce it before changing **Run** lifecycle state, rather than leaving **Model Projection**, **UI Projection**, or clients to infer unresolved tool-call meaning.
- Runtime terminalization closes only unresolved tool calls produced by the current **Run**; repairing unresolved tool calls from older Runs is migration/repair behavior, not current Run terminalization.
- Parent **Run** terminalization does not recursively close tool calls inside **Spawned Runs** or **Sub-sessions**; each **Run** terminalizes its own tool calls, while the parent only closes the parent Timeline's sub-agent tool call.
- Tool-call closure should expose distinct terminal operations: completion asserts calls are already closed, while failed and cancelled paths close unresolved calls as **Tool Result Errors** with path-specific reasons.
- A bare generic error is not canonical **Session Timeline** content.
- **Provider failures** are **Run** lifecycle failures by default, not assistant timeline content.
- If a provider stream emitted partial assistant output before failing, the emitted content may remain in the **Session Timeline** while the failure is recorded on the **Run**.
- A **Compaction Entry** is the only currently accepted system-generated **Timeline Entry**.
- A **Compaction Boundary** controls **Model Projection** but is not itself model-visible content.
- A **Compaction Summary** is model-visible as replacement context for older timeline content.
- A **Compaction Notice** is user-visible through **UI Projection** but is not a **Timeline Entry** and is excluded from **Model Projection**.
- Error-like timeline content is canonical only as a **Tool Result Error** that closes a tool call; current generic `kind="error"` records are legacy implementation details to migrate away from.
- Tool-call closure readers may treat legacy `kind="error"` records with tool source/call id as closing a tool call for compatibility, but new writes must use canonical tool-result **Timeline Parts** and the legacy shape should be fully migrated away.
- Runtime terminalization does not migrate legacy tool error closures in place; legacy migration/repair is a separate operation from enforcing the current Run closure invariant.
- Raw observability/runtime events are developer-facing traces; only sanitized, replayable **Runtime Notices** should become ordinary session replay material.
- Auto compaction may happen inside a **Run** only at model-request boundaries, never during an active provider stream.
- **Compaction** prepares future model context; it does not mutate the context of an in-flight provider request.
- Manual compaction should be represented by one **Compaction Run**.
- Auto compaction is an internal step of the current **Run**, not a separate durable **Run**.
- A compaction summary model call is observability/model-call detail, not a canonical **Run**.

## Example dialogue

> **Dev:** "When a **Run** calls a tool, should the resulting history live under the Run?"
> **Domain expert:** "No — the assistant output is a **Timeline Entry** in the **Session Timeline**; the tool call is a **Timeline Part** inside that entry, and the **Run** is only execution provenance."

## Flagged ambiguities

- "message" can mean persisted history, provider input, or streamed UI output — resolved: use **Timeline Entry** for persisted session history and avoid naked "Message" in domain language.
- "run history" suggests a **Run** owns transcript content — resolved: durable history belongs to the **Session Timeline**.
- A bare `runId` on history records suggests ownership — resolved: use **Produced By Run** as the canonical provenance relationship.
- Independent run provenance on **Timeline Parts** is unnecessary until cross-run mutation of a single **Timeline Entry** becomes a real use case.
- Run-based transcript ordering suggests **Runs** own history — resolved: top-level ordering belongs to the **Session Timeline**, while **Timeline Parts** use entry-local ordering.
- Run lifecycle state can be user-visible without being timeline content — resolved: **UI Projection** may display **Run** state, but **Runs** are not **Timeline Entries**.
- One **Run** can look like one user entry plus one assistant entry in simple prompts, but tool loops can produce multiple assistant **Timeline Entries** in the same **Run** — resolved: closure logic must locate the entry that contains the tool call rather than assuming one assistant entry per Run.
- Permission approval flow can be user-visible without being timeline content — resolved: **Permission Requests** are separate state shown by **UI Projection**, while the **Session Timeline** records durable content such as tool calls/results.
- "transcript" suggests a text-only chat record — resolved: use **Session Timeline** as the canonical term because the history also contains tool calls, tool results, patches, errors, reasoning, and compaction boundaries.
- "fork" suggests a user-visible branch from a timeline position — resolved: current parent/child session behavior is **Sub-session** for sub-agent isolation, not fork.
- "parent run" can suggest ownership — resolved: a **Spawned Run** belongs to its own **Sub-session** and only records which parent **Run** started it.
- Runtime diagnostics can be user-visible without being model-visible or timeline content — resolved: **UI Projection** can combine **Session Timeline** content with sanitized **Runtime Notices**, while **Model Projection** reads only model-relevant session context.
- `kind="error"` suggests any error may be timeline content — resolved: canonical error-like timeline content is limited to **Tool Result Error** for tool-call protocol closure; provider failures belong to **Run** lifecycle state and compaction failures that affect users become **Compaction Notices**.
- "synthetic" describes what a timeline entry is not, rather than what it is — resolved: use **Compaction Entry** as the canonical term; current implementations may still expose a legacy synthetic role until migrated.
- `command` and `summarize` run triggers encode current compaction implementation details — resolved: use **Compaction Run** for user-requested compaction lifecycle, and treat compaction summary model calls as observability/model-call detail rather than canonical Runs.
