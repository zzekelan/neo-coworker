import { describe, expect, test } from "bun:test"
import { buildStartRunInput, startRunBodySchema } from "../../src/app-server/server"

describe("startRunBodySchema", () => {
  test("accepts an optional agent field", () => {
    const result = startRunBodySchema.parse({
      prompt: "hello",
      agent: "plan",
    })

    expect(result).toEqual({
      prompt: "hello",
      agent: "plan",
    })
  })

  test("remains backwards compatible when agent is omitted", () => {
    const result = startRunBodySchema.parse({
      prompt: "hello",
    })

    expect(result.prompt).toBe("hello")
    expect(result.agent).toBeUndefined()
  })
})

describe("buildStartRunInput", () => {
  test("threads parsed agent into the run-start flow input", () => {
    const parsed = startRunBodySchema.parse({
      prompt: "hello",
      agent: "plan",
      runId: "run_123",
      messageId: "message_123",
    })

    expect(buildStartRunInput("session_123", parsed)).toEqual({
      sessionId: "session_123",
      prompt: "hello",
      agent: "plan",
      trigger: undefined,
      runId: "run_123",
      messageId: "message_123",
    })
  })

  test("keeps agent undefined when omitted", () => {
    const parsed = startRunBodySchema.parse({
      prompt: "hello",
    })

    expect(buildStartRunInput("session_123", parsed).agent).toBeUndefined()
  })
})
