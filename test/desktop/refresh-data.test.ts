import { describe, expect, test } from "bun:test"
import { loadDesktopRefreshCore } from "../../src/desktop/src/refresh-data"

function createMinimalLoaders(overrides: Record<string, unknown> = {}) {
  const sessionSummary = {
    id: "session-1",
    directory: "/workspace/alpha",
    workspaceRoot: "/workspace/alpha",
    createdAt: 1,
    title: "Alpha session",
    updatedAt: 2,
    latestUserMessagePreview: "hello",
    activeSkills: [],
    latestRunStatus: null,
  }

  return {
    async loadWorkspaces() {
      return {
        workspaces: [
          {
            workspaceRoot: "/workspace/alpha",
            name: "alpha",
            latestActivityAt: 10,
            sessionCount: 1,
            hasBusySession: false,
            sessions: [],
          },
        ],
      }
    },
    async loadWorkspaceSessions() {
      return { sessions: [sessionSummary] }
    },
    async loadWorkspaceSkills() {
      return { skills: [] }
    },
    async loadSession() {
      return {
        session: sessionSummary,
        latestRun: null,
        activeRun: null,
        contextUsage: null,
        status: "idle" as const,
        ...overrides,
      }
    },
    async loadTimeline() {
      return { timeline: [] }
    },
    async loadSessionRuns() {
      return { runs: [] }
    },
    async loadRun() {
      throw new Error("no active run")
    },
  }
}

describe("desktop refresh data", () => {
  test("keeps session restore on the main path when workspace skills fail later", async () => {
    let loadSkillsCalls = 0

    const refreshData = await loadDesktopRefreshCore({
      loaders: {
        async loadWorkspaces() {
          return {
            workspaces: [
              {
                workspaceRoot: "/workspace/alpha",
                name: "alpha",
                latestActivityAt: 10,
                sessionCount: 1,
                hasBusySession: false,
                sessions: [],
              },
            ],
          }
        },
        async loadWorkspaceSessions() {
          return {
            sessions: [
              {
                id: "session-1",
                directory: "/workspace/alpha",
                workspaceRoot: "/workspace/alpha",
                createdAt: 1,
                title: "Alpha session",
                updatedAt: 2,
                latestUserMessagePreview: "hello",
                activeSkills: ["reviewer"],
                latestRunStatus: null,
              },
            ],
          }
        },
        async loadWorkspaceSkills() {
          loadSkillsCalls += 1
          throw new Error("ENOENT: broken skill symlink")
        },
        async loadSession() {
          return {
            session: {
              id: "session-1",
              directory: "/workspace/alpha",
              workspaceRoot: "/workspace/alpha",
              createdAt: 1,
              title: "Alpha session",
              updatedAt: 2,
              latestUserMessagePreview: "hello",
              activeSkills: ["reviewer"],
              latestRunStatus: null,
            },
            latestRun: null,
            activeRun: null,
            contextUsage: null,
            status: "idle",
          }
        },
        async loadTimeline() {
          return {
            timeline: [
              {
                id: "message-1",
                sessionId: "session-1",
                runId: "run-1",
                role: "user",
                sequence: 1,
                createdAt: 3,
                parts: [
                  {
                    id: "part-1",
                    sessionId: "session-1",
                    runId: "run-1",
                    messageId: "message-1",
                    kind: "text",
                    sequence: 1,
                    text: "hello",
                    data: null,
                    createdAt: 3,
                  },
                ],
              },
            ],
          }
        },
        async loadSessionRuns() {
          return {
            runs: [],
          }
        },
        async loadRun() {
          throw new Error("run state should not load when no active run exists")
        },
      },
      knownWorkspaces: new Map(),
      requestedWorkspaceRoot: "/workspace/alpha",
      preferredSessionId: "session-1",
    })

    expect(refreshData.resolvedWorkspaceRoot).toBe("/workspace/alpha")
    expect(refreshData.activeSessionId).toBe("session-1")
    expect(refreshData.sessionRuns).toEqual([])
    expect(refreshData.timeline).toHaveLength(1)
    expect(refreshData.sessionRestoreError).toBeNull()
    expect(loadSkillsCalls).toBe(0)

    await expect(refreshData.loadSkills()).resolves.toEqual({
      skills: [],
      warningMessage: "Could not load workspace skills: ENOENT: broken skill symlink",
    })
    expect(loadSkillsCalls).toBe(1)
  })

  test("passes contextUsage from the session snapshot through to the result", async () => {
    const contextUsage = {
      contextTokens: 42_000,
      contextWindow: 128_000,
      utilizationPercent: 33,
      source: "provider" as const,
    }

    const refreshData = await loadDesktopRefreshCore({
      loaders: createMinimalLoaders({ contextUsage }),
      knownWorkspaces: new Map(),
      requestedWorkspaceRoot: "/workspace/alpha",
      preferredSessionId: "session-1",
    })

    expect(refreshData.snapshot).not.toBeNull()
    expect(refreshData.snapshot!.contextUsage).toEqual(contextUsage)
  })

  test("snapshot contextUsage is null when server returns no context usage", async () => {
    const refreshData = await loadDesktopRefreshCore({
      loaders: createMinimalLoaders({ contextUsage: null }),
      knownWorkspaces: new Map(),
      requestedWorkspaceRoot: "/workspace/alpha",
      preferredSessionId: "session-1",
    })

    expect(refreshData.snapshot).not.toBeNull()
    expect(refreshData.snapshot!.contextUsage).toBeNull()
  })

  test("returns only pending permission requests for the active run, sorted by createdAt then id", async () => {
    const activeRun = {
      id: "run-1",
      sessionId: "session-1",
      trigger: "prompt" as const,
      status: "waiting_permission" as const,
      createdAt: 5,
      startedAt: 5,
      finishedAt: null,
      errorText: null,
      activeSkills: [],
      parentRunId: null,
    }
    const sessionSummary = {
      id: "session-1",
      directory: "/workspace/alpha",
      workspaceRoot: "/workspace/alpha",
      createdAt: 1,
      title: "Alpha session",
      updatedAt: 2,
      latestUserMessagePreview: "hello",
      activeSkills: [],
      latestRunStatus: "waiting_permission" as const,
    }

    const refreshData = await loadDesktopRefreshCore({
      loaders: {
        async loadWorkspaces() {
          return {
            workspaces: [
              {
                workspaceRoot: "/workspace/alpha",
                name: "alpha",
                latestActivityAt: 10,
                sessionCount: 1,
                hasBusySession: true,
                sessions: [],
              },
            ],
          }
        },
        async loadWorkspaceSessions() {
          return { sessions: [sessionSummary] }
        },
        async loadWorkspaceSkills() {
          return { skills: [] }
        },
        async loadSession() {
          return {
            session: sessionSummary,
            latestRun: activeRun,
            activeRun,
            contextUsage: null,
            status: "busy" as const,
          }
        },
        async loadTimeline() {
          return { timeline: [] }
        },
        async loadSessionRuns() {
          return { runs: [activeRun] }
        },
        async loadRun() {
          return {
            run: activeRun,
            permissionRequests: [
              {
                id: "perm-c",
                runId: "run-1",
                sessionId: "session-1",
                toolName: "webfetch",
                reason: "webfetch third",
                status: "pending" as const,
                createdAt: 100,
                resolvedAt: null,
              },
              {
                id: "perm-a",
                runId: "run-1",
                sessionId: "session-1",
                toolName: "webfetch",
                reason: "webfetch first",
                status: "pending" as const,
                createdAt: 100,
                resolvedAt: null,
              },
              {
                id: "perm-b",
                runId: "run-1",
                sessionId: "session-1",
                toolName: "webfetch",
                reason: "webfetch second",
                status: "approved" as const,
                createdAt: 90,
                resolvedAt: 95,
              },
              {
                id: "perm-d",
                runId: "run-1",
                sessionId: "session-1",
                toolName: "write",
                reason: "write later",
                status: "pending" as const,
                createdAt: 101,
                resolvedAt: null,
              },
            ],
          }
        },
      },
      knownWorkspaces: new Map(),
      requestedWorkspaceRoot: "/workspace/alpha",
      preferredSessionId: "session-1",
    })

    expect(refreshData.permissionRequests.map((request) => request.id)).toEqual([
      "perm-a",
      "perm-c",
      "perm-d",
    ])
    expect(
      refreshData.permissionRequests.every((request) => request.status === "pending"),
    ).toBe(true)
  })
})
