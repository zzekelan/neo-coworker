import { describe, expect, test } from "bun:test"
import { loadDesktopRefreshCore } from "../../src/desktop/src/refresh-data"

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
            },
            latestRun: null,
            activeRun: null,
            status: "idle",
          }
        },
        async loadTranscript() {
          return {
            transcript: [
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
      defaultWorkspaceRoot: null,
      preferredSessionId: "session-1",
    })

    expect(refreshData.resolvedWorkspaceRoot).toBe("/workspace/alpha")
    expect(refreshData.activeSessionId).toBe("session-1")
    expect(refreshData.sessionRuns).toEqual([])
    expect(refreshData.transcript).toHaveLength(1)
    expect(refreshData.sessionRestoreError).toBeNull()
    expect(loadSkillsCalls).toBe(0)

    await expect(refreshData.loadSkills()).resolves.toEqual({
      skills: [],
      warningMessage: "Could not load workspace skills: ENOENT: broken skill symlink",
    })
    expect(loadSkillsCalls).toBe(1)
  })
})
