import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop app state flow", () => {
  test("keeps async skill saves from stealing focus away from the current session", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("setSelectionRef({")
    expect(source).toContain("activeWorkspaceRoot: workspaceRoot,")
    expect(source).toContain("activeSessionId: sessionId,")
    expect(source).toContain("previous.activeWorkspaceRoot === updated.session.workspaceRoot")
    expect(source).toContain("previous.activeSessionId === updated.session.id && previous.sessionSnapshot")
    expect(source).toContain("sessionId: selectionRef.current.activeSessionId")
    expect(source).not.toContain("sessionId: updated.session.id")
  })

  test("refreshes workspace summaries from the server instead of mutating truncated previews locally", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("const syncWorkspaces = useEffectEvent(async () => {")
    expect(source).toContain("const workspaceData = await loadWorkspaces()")
    expect(source).toContain("mergeWorkspaces(workspaceData.workspaces, knownWorkspacesRef.current)")
    expect(source).toContain("void syncWorkspaces()")
    expect(source).not.toContain("function upsertWorkspaceSession(")
    expect(source).not.toContain("function removeWorkspaceSession(")
  })

  test("evicts deleted sessions from live state and exposes a full refresh for settings restarts", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("if (event.type === \"session.deleted\")")
    expect(source).toContain("sessionId: activeSessionId === event.sessionId ? null : activeSessionId")
    expect(source).toContain("async refreshAppState()")
  })
})
