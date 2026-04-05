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
    expect(source).toContain("hasAuthoritativeWorkspaceBusyState: true")
    expect(source).toContain("hasAuthoritativeWorkspaceBusyState: false")
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

  test("stores context usage from events and clears it on terminal run or session switch", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("contextUsage: ContextUsageState | null")
    expect(source).toContain("event.type === \"context.usage.updated\"")
    expect(source).toContain("contextTokens: event.contextTokens")
    expect(source).toContain("contextWindow: event.contextWindow")
    expect(source).toContain("utilizationPercent: event.utilizationPercent")
    expect(source).toContain("source: event.source")
    expect(source).toContain("contextUsage: terminal ? null : previous.contextUsage")
    expect(source).toContain("contextUsage: null,\n      })")
  })

  test("hydrates contextUsage from the REST session snapshot on refresh", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("contextUsage: refreshData.snapshot?.contextUsage ?? null")
  })
})
