import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop app state flow", () => {
  test("keeps async skill saves from stealing focus away from the current session", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("workspaces: upsertWorkspaceSession(previous.workspaces, updated.session)")
    expect(source).toContain("previous.activeWorkspaceRoot === updated.session.workspaceRoot")
    expect(source).toContain("previous.activeSessionId === updated.session.id && previous.sessionSnapshot")
    expect(source).toContain("sessionId: selectionRef.current.activeSessionId")
    expect(source).not.toContain("sessionId: updated.session.id")
  })

  test("updates workspace summaries for session events and evicts deleted sessions from live state", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("if (event.type === \"session.deleted\")")
    expect(source).toContain("workspaces: removeWorkspaceSession(previous.workspaces, {")
    expect(source).toContain("function upsertWorkspaceSession(")
    expect(source).toContain("function removeWorkspaceSession(")
    expect(source).toContain("sessionId: activeSessionId === event.sessionId ? null : activeSessionId")
  })
})
