import { describe, expect, test } from "bun:test"
import { type RuntimeEvent, RunSchema } from "../../src/orchestration"
import { createEventQueue } from "../../src/orchestration/infrastructure/runtime/event-queue"

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

  test("streams events pushed after consumption starts in insertion order", async () => {
    const queue = createEventQueue<RuntimeEvent>()
    const events: RuntimeEvent["type"][] = []

    const consume = (async () => {
      for await (const event of queue.stream()) events.push(event.type)
    })()

    await Promise.resolve()

    queue.push({ type: "run.started", runId: "run_1" })
    queue.push({ type: "run.completed", runId: "run_1" })
    queue.close()

    await consume

    expect(events).toEqual(["run.started", "run.completed"])
  })

  test("throws when pushing after close", () => {
    const queue = createEventQueue<RuntimeEvent>()

    queue.close()

    expect(() =>
      queue.push({ type: "run.started", runId: "run_1" }),
    ).toThrow("closed")
  })
})
