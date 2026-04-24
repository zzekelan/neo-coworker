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

  test("ignores sub-session live events when maintaining the sidebar session list", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("function isSidebarVisibleSession(session: DesktopSessionSummary & { parentSessionId?: string })")
    expect(source).toContain("if (!isSidebarVisibleSession(session))")
    expect(source).toContain("return sessions.filter((candidate) => candidate.id !== session.id)")
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

  test("loads primary agents for the resolved workspace so custom backend agents can appear", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("void loadPrimaryAgents(refreshData.resolvedWorkspaceRoot ?? undefined)")
  })

  test("intercepts /compact as a command instead of sending it as a prompt", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain('if (trimmedPrompt === "/compact")')
    expect(source).toContain("return actions.compactSession()")
  })

  test("compactSession calls the dedicated compact endpoint and does not create a user message", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("async compactSession()")
    expect(source).toContain("await compactSession(sessionId)")
    expect(source).toContain("preserveTranscript: true")
  })

  test("compactSession requires an active session and surfaces an error if none exists", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    const compactBlock = source.slice(
      source.indexOf("async compactSession()"),
      source.indexOf("async cancelRun()"),
    )

    expect(compactBlock).toContain("selectionRef.current.activeSessionId")
    expect(compactBlock).toContain("if (!sessionId)")
    expect(compactBlock).toContain("No active session to compact.")
    expect(compactBlock).toContain("return false")
  })

  test("compactSession sets isSending while running and clears it on error", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    const compactBlock = source.slice(
      source.indexOf("async compactSession()"),
      source.indexOf("async cancelRun()"),
    )

    expect(compactBlock).toContain("isSending: true")
    expect(compactBlock).toContain("actionError: null")
    expect(compactBlock).toContain("isSending: false")
    expect(compactBlock).toContain("actionError: toErrorMessage(error)")
  })

  test("compactSession does not auto-create a session when none is active", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    const compactBlock = source.slice(
      source.indexOf("async compactSession()"),
      source.indexOf("async cancelRun()"),
    )

    expect(compactBlock).not.toContain("createSession")
  })
})

describe("desktop api client", () => {
  test("subscribes to structured lifecycle server events", () => {
    const apiSource = readFileSync("src/desktop/src/api.ts", "utf8")
    const typesSource = readFileSync("src/desktop/src/types.ts", "utf8")

    for (const eventType of [
      "subagent.started",
      "subagent.completed",
      "subagent.failed",
      "skill.load.requested",
      "skill.load.completed",
      "skill.load.failed",
    ]) {
      expect(apiSource).toContain(`"${eventType}"`)
      expect(typesSource).toContain(`"${eventType}"`)
    }

    expect(typesSource).toContain("agentId: string")
    expect(typesSource).toContain("displayName: string")
    expect(typesSource).toContain("errorMessage?: string")
  })

  test("exposes a compactSession function that POSTs to the compact endpoint", () => {
    const source = readFileSync("src/desktop/src/api.ts", "utf8")

    expect(source).toContain("export async function compactSession(sessionId: string)")
    expect(source).toContain("/sessions/${encodeURIComponent(sessionId)}/compact")
    expect(source).toContain('method: "POST"')
  })

  test("compactSession returns the run from the envelope", () => {
    const source = readFileSync("src/desktop/src/api.ts", "utf8")

    expect(source).toContain("requestApi<{ run: DesktopRun }>(")
  })

  test("upserts per-request permission updates with deterministic ordering and sibling preservation", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("function upsertPermissionRequest(")
    expect(source).toContain("requests.filter((candidate) => candidate.id !== request.id)")
    expect(source).toContain("if (request.status === \"pending\")")
    expect(source).toContain("pending.push(request)")
    expect(source).toContain("if (left.createdAt !== right.createdAt)")
    expect(source).toContain("return left.createdAt - right.createdAt")
    expect(source).toContain("if (left.id < right.id) return -1")
    expect(source).toContain("if (left.id > right.id) return 1")
  })
})
