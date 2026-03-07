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

  test("throws when appending to an unknown session", () => {
    const store = createStore()

    expect(() =>
      store.appendMessage({
        sessionId: "session_missing",
        runId: "run_1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      }),
    ).toThrow("Unknown session: session_missing")
  })

  test("returns a defensive copy from listMessages", () => {
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
    transcript.push({
      sessionId: session.id,
      runId: run.id,
      role: "assistant",
      parts: [{ type: "text", text: "mutated" }],
    })

    expect(store.listMessages(session.id)).toHaveLength(1)
    expect(store.listMessages(session.id)[0]?.role).toBe("user")
  })
})
