import { describe, expect, test } from "bun:test"
import { createSubAgentContext } from "../../src/agent"

describe("createSubAgentContext", () => {
  test("returns a unique subRunId while preserving sessionId", () => {
    const first = createSubAgentContext({ sessionId: "session-1" })
    const second = createSubAgentContext({ sessionId: "session-1" })

    expect(first.sessionId).toBe("session-1")
    expect(second.sessionId).toBe("session-1")
    expect(first.subRunId).toMatch(/^run_/)
    expect(second.subRunId).toMatch(/^run_/)
    expect(first.subRunId).not.toBe(second.subRunId)
  })

  test("propagates parent aborts to the child signal", () => {
    const parent = new AbortController()
    const context = createSubAgentContext({
      sessionId: "session-1",
      signal: parent.signal,
    })

    expect(context.signal.aborted).toBe(false)

    parent.abort("stop")

    expect(context.signal.aborted).toBe(true)
    expect(context.signal.reason).toBe("stop")
  })

  test("immediately aborts when the parent signal is already aborted", () => {
    const parent = new AbortController()
    parent.abort("already-stopped")

    const context = createSubAgentContext({
      sessionId: "session-1",
      signal: parent.signal,
    })

    expect(context.signal.aborted).toBe(true)
    expect(context.signal.reason).toBe("already-stopped")
  })
})
