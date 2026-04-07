import { describe, expect, it } from "bun:test"
import { readEnvWithFallback } from "../../src/bootstrap/env"

describe("readEnvWithFallback", () => {
  it("prefers new key when both are set", () => {
    const env = { NCOWORKER_SERVER_PORT: "4000", AGENT_SERVER_PORT: "3000" }
    expect(readEnvWithFallback(env, "NCOWORKER_SERVER_PORT", "AGENT_SERVER_PORT")).toBe("4000")
  })

  it("falls back to legacy key when new key is absent", () => {
    const env = { AGENT_SERVER_HOST: "127.0.0.1" }
    expect(readEnvWithFallback(env, "NCOWORKER_SERVER_HOST", "AGENT_SERVER_HOST")).toBe("127.0.0.1")
  })

  it("returns undefined when neither key is set", () => {
    expect(readEnvWithFallback({}, "NCOWORKER_SERVER_HOST", "AGENT_SERVER_HOST")).toBeUndefined()
  })
})
