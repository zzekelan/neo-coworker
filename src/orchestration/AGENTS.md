# ORCHESTRATION KNOWLEDGE BASE

## OVERVIEW
`src/orchestration/` owns the run loop: model turns, tool execution, permission suspension/resume, compaction, and active-run lifecycle.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Main step loop | `application/step-service.ts` | Largest hotspot; model/tool/compaction orchestration |
| Runtime entry | `infrastructure/runtime/create-runtime.ts` | Active runs, resume, permission replay |
| Run loop machinery | `infrastructure/runtime/loop.ts` | Event consumption and lifecycle control |
| Suspension behavior | `infrastructure/runtime/run-suspension.ts` | Waiting-permission and replay mechanics |
| Run registry | `infrastructure/runtime/active-run-registry.ts` | Process-local run ownership |
| Cross-module contracts | `application/ports/*` | Only approved capability contracts |

## CONVENTIONS
- Treat `application/ports/*` as the only orchestration-facing contracts for session, model, permission, skill, and tool.
- Keep orchestration-owned runtime machinery in `infrastructure/runtime/`, not in `application/`.
- Compaction recovery must preserve active skills, recent-file reminders, and next-step continuity.
- Emit stable runtime events when changing behavior; downstream telemetry and evals depend on them.
- **Concurrent Batch Execution**: Multiple tool calls in a single turn are executed in parallel via `OrchestrationToolPort.executeBatch` if they are `read-only`.
- **Modular Prompt Composition**: The system prompt is assembled from static sections (`getStaticPrompt()`) and dynamic context (`buildLateContextMessage()`).
- **Late Context Injection**: Dynamic information (date, working directory, active skills) is injected as an ephemeral system reminder at the end of the conversation before each turn, keeping the system prompt cache-stable.
- **Micro-Compaction**: Individual message parts are compressed based on the `isCompressible` metadata instead of hardcoded tool lists.

## HOTSPOTS
- `application/step-service.ts` — compaction, retry, tool call flow, transcript mutation.
- `infrastructure/runtime/create-runtime.ts` — run creation, detach/resume, permission recovery.
- `infrastructure/runtime/loop.ts` — cancellation, event sequencing, live run execution.
- `application/prompt-composer.ts` — modular prompt assembly and late context generation.

## ANTI-PATTERNS
- Do not import capability modules directly from orchestration internals; use `application/ports/*`.
- Do not move runtime-only registries or suspension handles into `application/` catch-alls.
- Do not change compaction summaries or recovery behavior without updating eval coverage.
- Do not bypass abort/cancel handling inside model or tool loops.
- Do not put dynamic, turn-specific data in the system prompt; use the late context message.

## TESTS TO RUN
```bash
bun test test/orchestration
bun test test/runtime/loop.test.ts
bun test test/runtime/permission-flow.test.ts
bun test test/evals
bun run test:structure
```

## CHANGE CHECKLIST
- If you change tool-call sequencing, re-check transcript ordering and tool-result consumption.
- If you change compaction, run live/scripted evals covering compaction and skill persistence.
- If you change permission suspension, verify duplicate replies, cancel paths, and resume behavior.
- If you add a new orchestration dependency, expose it as a precise port first.
