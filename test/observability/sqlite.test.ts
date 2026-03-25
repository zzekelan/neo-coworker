import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  createObservabilityRepository,
  type StoredRunEvent,
} from "../../src/observability"

describe("observability sqlite repository", () => {
  test("assigns stable per-run sequence order independent of timestamp ties", () => {
    const database = new Database(":memory:")

    try {
      const repository = createObservabilityRepository({
        database,
        now: () => 100,
        createId(prefix) {
          return `${prefix}_${crypto.randomUUID()}`
        },
      })

      repository.runEvents.append({
        sessionId: "session_1",
        runId: "run_1",
        source: "orchestration",
        eventType: "run.started",
        createdAt: 100,
      })
      repository.runEvents.append({
        sessionId: "session_1",
        runId: "run_2",
        source: "orchestration",
        eventType: "run.started",
        createdAt: 100,
      })
      repository.runEvents.append({
        sessionId: "session_1",
        runId: "run_1",
        source: "tool",
        eventType: "tool.executed",
        data: { toolName: "read" },
        createdAt: 100,
      })

      expect(readEventTypes(repository.runEvents.listByRun("run_1"))).toEqual([
        "run.started",
        "tool.executed",
      ])
      expect(repository.runEvents.listByRun("run_1").map((event) => event.sequence)).toEqual([0, 1])
      expect(repository.runEvents.listByRun("run_2").map((event) => event.sequence)).toEqual([0])
    } finally {
      database.close(false)
    }
  })
})

function readEventTypes(events: StoredRunEvent[]) {
  return events.map((event) => event.eventType)
}
