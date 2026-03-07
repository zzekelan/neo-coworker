import { describe, expect, test } from "bun:test"
import { RunSchema } from "../../src/runtime/types"
import { createEventQueue } from "../../src/runtime/event-queue"

describe("runtime entities", () => {
  test("validates a run shape", () => {
    const run = RunSchema.parse({
      id: "run_1",
      sessionId: "session_1",
      trigger: "cli",
      status: "queued",
    })

    expect(run.status).toBe("queued")
  })

  test("streams events in insertion order", async () => {
    const queue = createEventQueue<{
      type: string
      runId: string
    }>()

    queue.push({ type: "run.started", runId: "run_1" })
    queue.push({ type: "run.completed", runId: "run_1" })
    queue.close()

    const events: string[] = []
    for await (const event of queue.stream()) events.push(event.type)

    expect(events).toEqual(["run.started", "run.completed"])
  })
})
