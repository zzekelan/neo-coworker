import { describe, expect, test } from "bun:test"
import { createStore } from "../../src/runtime/store"

describe("runtime store", () => {
  test("creates session, run, and transcript messages", () => {
    const store = createStore()
    const session = store.createSession({
      cwd: "/tmp/demo",
      workspaceRoot: "/tmp/demo",
    })
    const run = store.createRun({ sessionId: session.id, trigger: "cli" })

    store.appendMessage({
      sessionId: session.id,
      runId: run.id,
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    })

    const transcript = store.listMessages(session.id)
    expect(transcript).toHaveLength(1)
    expect(transcript[0]?.role).toBe("user")
  })
})
