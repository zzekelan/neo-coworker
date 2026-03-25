import { describe, expect, test } from "bun:test"
import {
  createObservabilityRuntimeApi,
  type CreateRunEventInput,
  type StoredRunEvent,
} from "../../src/observability"

function createRepository() {
  const runEvents: StoredRunEvent[] = []

  return {
    repository: {
      runEvents: {
        append(input: CreateRunEventInput) {
          const record: StoredRunEvent = {
            id: input.id ?? `event_${runEvents.length + 1}`,
            sessionId: input.sessionId,
            runId: input.runId,
            sequence: runEvents.length,
            source: input.source,
            eventType: input.eventType,
            data: input.data ?? {},
            createdAt: input.createdAt ?? 0,
          }
          runEvents.push(record)
          return record
        },
        listByRun(runId: string) {
          return runEvents.filter((event) => event.runId === runId)
        },
      },
    },
    runEvents,
  }
}

describe("observability runtime api", () => {
  test("normalizes source-specific observer events into durable run events", () => {
    const harness = createRepository()
    const runtime = createObservabilityRuntimeApi({
      repository: harness.repository,
      now: () => 42,
    })

    runtime.runtimeObserver.recordRuntimeEvent({
      sessionId: "session_1",
      runId: "run_1",
      event: {
        type: "run.started",
      },
    })
    runtime.toolObserver.recordToolEvent({
      type: "tool.executed",
      sessionId: "session_1",
      runId: "run_1",
      toolName: "read",
    })

    expect(harness.runEvents).toEqual([
      {
        id: "event_1",
        sessionId: "session_1",
        runId: "run_1",
        sequence: 0,
        source: "orchestration",
        eventType: "run.started",
        data: {},
        createdAt: 42,
      },
      {
        id: "event_2",
        sessionId: "session_1",
        runId: "run_1",
        sequence: 1,
        source: "tool",
        eventType: "tool.executed",
        data: {
          toolName: "read",
        },
        createdAt: 42,
      },
    ])
    expect(runtime.exportRunTrace("run_1")).toEqual({
      sessionId: "session_1",
      runId: "run_1",
      events: harness.runEvents,
    })
  })
})
