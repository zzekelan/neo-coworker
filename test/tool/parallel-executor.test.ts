import { describe, expect, test } from "bun:test"
import {
  ParallelizationClass,
  type ToolObserverEvent,
} from "../../src/tool"
import {
  MAX_PARALLEL_BATCH_SIZE,
  ParallelExecutor,
  type ParallelExecutorToolCall,
} from "../../src/tool/application/parallel-executor"

describe("parallel executor", () => {
  test("groups parallel-safe calls into a single execution batch", () => {
    const executor = new ParallelExecutor()

    const batches = executor.planExecution([
      createCall("read", { path: "src/app.ts" }),
      createCall("glob", { pattern: "**/*.ts" }),
      createCall("grep", { pattern: "TODO" }),
    ])

    expect(batches).toEqual([
      [
        createCall("read", { path: "src/app.ts" }),
        createCall("glob", { pattern: "**/*.ts" }),
        createCall("grep", { pattern: "TODO" }),
      ],
    ])
  })

  test("separates never-parallel calls from neighboring safe calls", () => {
    const executor = new ParallelExecutor()

    const batches = executor.planExecution([
      createCall("read", { path: "src/app.ts" }),
      createCall("shell", { command: "pwd" }),
      createCall("glob", { pattern: "**/*.ts" }),
    ])

    expect(batches).toEqual([
      [createCall("read", { path: "src/app.ts" })],
      [createCall("shell", { command: "pwd" })],
      [createCall("glob", { pattern: "**/*.ts" })],
    ])
  })

  test("splits overlapping path-scoped calls and emits conflict telemetry", () => {
    const events: ToolObserverEvent[] = []
    const executor = new ParallelExecutor(new Map(), {
      observer: createObserver(events),
      observerContext: { sessionId: "session-1", runId: "run-1" },
    })

    const batches = executor.planExecution([
      createCall("write", { path: "src" }),
      createCall("edit", { path: "src/app.ts" }),
      createCall("read", { path: "docs/readme.md" }),
    ])

    expect(batches).toEqual([
      [createCall("write", { path: "src" })],
      [
        createCall("edit", { path: "src/app.ts" }),
        createCall("read", { path: "docs/readme.md" }),
      ],
    ])

    const conflictEvent = events.find((event) => event.type === "parallel.conflict_detected")
    expect(conflictEvent).toBeDefined()
    if (conflictEvent?.type !== "parallel.conflict_detected") {
      throw new Error("Expected parallel.conflict_detected event")
    }
    expect(conflictEvent.sessionId).toBe("session-1")
    expect(conflictEvent.runId).toBe("run-1")
    expect(conflictEvent.payload).toEqual({
      tools: ["write", "edit"],
      conflictingPaths: ["src", "src/app.ts"],
    })

    const planEvent = events.find((event) => event.type === "parallel.plan_generated")
    expect(planEvent).toBeDefined()
    if (planEvent?.type !== "parallel.plan_generated") {
      throw new Error("Expected parallel.plan_generated event")
    }
    expect(planEvent.payload).toEqual({
      totalCalls: 3,
      batchCount: 2,
      maxBatchSize: 2,
    })
  })

  test("enforces the max eight calls per batch limit", () => {
    const executor = new ParallelExecutor()
    const calls = Array.from({ length: MAX_PARALLEL_BATCH_SIZE + 2 }, (_value, index) =>
      createCall("read", { path: `src/file-${index}.ts` }),
    )

    const batches = executor.planExecution(calls)

    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(MAX_PARALLEL_BATCH_SIZE)
    expect(batches[1]).toHaveLength(2)
  })

  test("forces destructive shell calls into solo batches when shell is otherwise safe", () => {
    const executor = new ParallelExecutor(
      new Map([
        [
          "shell",
          {
            classification: ParallelizationClass.PARALLEL_SAFE,
            destructivePatterns: [/\brm\b/iu],
          },
        ],
      ]),
    )

    const batches = executor.planExecution([
      createCall("read", { path: "src/app.ts" }),
      createCall("shell", { command: "rm -rf tmp" }),
      createCall("glob", { pattern: "**/*.ts" }),
    ])

    expect(batches).toEqual([
      [createCall("read", { path: "src/app.ts" })],
      [createCall("shell", { command: "rm -rf tmp" })],
      [createCall("glob", { pattern: "**/*.ts" })],
    ])
  })

  test("keeps non-destructive shell calls batched when explicitly configured safe", () => {
    const executor = new ParallelExecutor(
      new Map([
        [
          "shell",
          {
            classification: ParallelizationClass.PARALLEL_SAFE,
            destructivePatterns: [/\brm\b/iu],
          },
        ],
      ]),
    )

    const batches = executor.planExecution([
      createCall("read", { path: "src/app.ts" }),
      createCall("shell", { command: "pwd" }),
      createCall("glob", { pattern: "**/*.ts" }),
    ])

    expect(batches).toEqual([
      [
        createCall("read", { path: "src/app.ts" }),
        createCall("shell", { command: "pwd" }),
        createCall("glob", { pattern: "**/*.ts" }),
      ],
    ])
  })

  test("schedule emits batch lifecycle telemetry while running sequential batches", async () => {
    const events: ToolObserverEvent[] = []
    const clock = createClock([100, 105, 200, 212])
    const executor = new ParallelExecutor(new Map(), {
      observer: createObserver(events),
      observerContext: { sessionId: "session-2", runId: "run-2" },
      now: clock,
    })
    const calls = Array.from({ length: MAX_PARALLEL_BATCH_SIZE + 1 }, (_value, index) =>
      createCall("read", { path: `src/file-${index}.ts` }),
    )

    const seenBatchIndexes: number[] = []
    const results = await executor.schedule(calls, async (batch, batchIndex) => {
      seenBatchIndexes.push(batchIndex)
      return batch.map((call) => String(call.args.path)).join(",")
    })

    expect(seenBatchIndexes).toEqual([0, 1])
    expect(results).toHaveLength(2)

    expect(events.map((event) => event.type)).toEqual([
      "parallel.plan_generated",
      "parallel.batch_started",
      "parallel.batch_completed",
      "parallel.batch_started",
      "parallel.batch_completed",
    ])

    const firstStarted = events[1]
    expect(firstStarted?.type).toBe("parallel.batch_started")
    if (firstStarted?.type !== "parallel.batch_started") {
      throw new Error("Expected first batch started event")
    }
    expect(firstStarted.payload).toEqual({
      batchIndex: 0,
      callCount: MAX_PARALLEL_BATCH_SIZE,
      toolNames: Array.from({ length: MAX_PARALLEL_BATCH_SIZE }, () => "read"),
    })

    const firstCompleted = events[2]
    expect(firstCompleted?.type).toBe("parallel.batch_completed")
    if (firstCompleted?.type !== "parallel.batch_completed") {
      throw new Error("Expected first batch completed event")
    }
    expect(firstCompleted.payload).toEqual({
      batchIndex: 0,
      durationMs: 5,
    })

    const secondCompleted = events[4]
    expect(secondCompleted?.type).toBe("parallel.batch_completed")
    if (secondCompleted?.type !== "parallel.batch_completed") {
      throw new Error("Expected second batch completed event")
    }
    expect(secondCompleted.payload).toEqual({
      batchIndex: 1,
      durationMs: 12,
    })
  })
})

function createCall(name: string, args: Record<string, unknown>): ParallelExecutorToolCall {
  return { name, args }
}

function createObserver(events: ToolObserverEvent[]) {
  return {
    recordToolEvent(event: ToolObserverEvent) {
      events.push(event)
    },
  }
}

function createClock(values: number[]) {
  let index = 0

  return () => {
    const value = values[index]
    index += 1

    if (value === undefined) {
      throw new Error("Test clock exhausted")
    }

    return value
  }
}
