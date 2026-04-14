import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  createObservabilityRuntimeApi,
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

  test("records memory and skill observer events with their sources", () => {
    const database = new Database(":memory:")

    try {
      const repository = createObservabilityRepository({
        database,
        now: () => 100,
        createId(prefix) {
          return `${prefix}_${crypto.randomUUID()}`
        },
      })
      const runtime = createObservabilityRuntimeApi({
        repository,
        now: () => 100,
      })

      runtime.memoryObserver.recordMemoryEvent({
        sessionId: "session_1",
        runId: "run_1",
        type: "memory.add",
        payload: {
          target: "agent",
        },
      })
      runtime.skillObserver.recordSkillEvent({
        sessionId: "session_1",
        runId: "run_1",
        type: "skill.created",
        payload: {
          skillName: "planner",
        },
      })

      expect(repository.runEvents.listByRun("run_1")).toEqual([
        expect.objectContaining({
          source: "memory",
          eventType: "memory.add",
          data: {
            payload: {
              target: "agent",
            },
          },
        }),
        expect.objectContaining({
          source: "skill",
          eventType: "skill.created",
          data: {
            payload: {
              skillName: "planner",
            },
          },
        }),
      ])
    } finally {
      database.close(false)
    }
  })

  test("recreates stale run_event source constraints when new sources are inserted", () => {
    const database = new Database(":memory:")

    try {
      database.exec(`
        CREATE TABLE run_event (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          source TEXT NOT NULL CHECK (source IN ('model', 'orchestration', 'permission', 'tool')),
          event_type TEXT NOT NULL,
          data_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (run_id, sequence)
        )
      `)
      database.exec(`
        CREATE INDEX run_event_session_run_sequence_idx
        ON run_event (session_id, run_id, sequence)
      `)
      database
        .query(
          `
            INSERT INTO run_event (
              id,
              session_id,
              run_id,
              sequence,
              source,
              event_type,
              data_json,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "event_existing",
          "session_legacy",
          "run_legacy",
          0,
          "tool",
          "tool.executed",
          JSON.stringify({ toolName: "read" }),
          10,
        )

      const repository = createObservabilityRepository({
        database,
        now: () => 100,
        createId(prefix) {
          return `${prefix}_${crypto.randomUUID()}`
        },
      })

      const appended = repository.runEvents.append({
        sessionId: "session_1",
        runId: "run_1",
        source: "memory",
        eventType: "memory.loaded",
        data: { target: "agent" },
        createdAt: 100,
      })

      expect(appended.source).toBe("memory")
      expect(repository.runEvents.listByRun("run_1")).toEqual([
        expect.objectContaining({
          source: "memory",
          eventType: "memory.loaded",
          data: { target: "agent" },
          sequence: 0,
        }),
      ])
      expect(repository.runEvents.listByRun("run_legacy")).toEqual([])

      const createSqlRow = database
        .query(
          `
            SELECT sql
            FROM sqlite_master
            WHERE type = 'table' AND name = 'run_event'
          `,
        )
        .get() as { sql: string } | null

      expect(createSqlRow?.sql).toContain("'memory'")
      expect(createSqlRow?.sql).toContain("'skill'")
    } finally {
      database.close(false)
    }
  })
})

function readEventTypes(events: StoredRunEvent[]) {
  return events.map((event) => event.eventType)
}
