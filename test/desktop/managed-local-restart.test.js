import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop managed local restart", () => {
  test("waits for the restarted app-server health endpoint before reporting ready", () => {
    const source = readFileSync("src/desktop/electron/main.mjs", "utf8")

    expect(source).toContain('waitForHttpReady(new URL("/sessions", startedOrigin).href)')
    expect(source).toContain("managed local app-server")
  })
})
