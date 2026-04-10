import { describe, expect, test } from "bun:test"

import { isSubSession } from "../../src/session/domain/session.ts"

describe("session domain", () => {
  test("reports whether a session has a parent session", () => {
    const topLevelSession = {
      parentSessionId: undefined,
    }
    const subSession = {
      parentSessionId: "session_parent",
    }

    expect(topLevelSession.parentSessionId).toBeUndefined()
    expect(isSubSession(topLevelSession)).toBe(false)
    expect(subSession.parentSessionId).toBe("session_parent")
    expect(isSubSession(subSession)).toBe(true)
  })
})
