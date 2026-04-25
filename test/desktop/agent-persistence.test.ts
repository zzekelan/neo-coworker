import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  DEFAULT_AGENT_NAME,
  resolveCurrentAgent,
} from "../../src/desktop/src/useDesktopApp"

describe("desktop agent persistence", () => {
  test("restores the persisted session agent from backend session data on reload", () => {
    expect(
      resolveCurrentAgent({
        activeSessionId: "session-plan",
        sessions: [
          createSessionSummary({
            id: "session-plan",
            currentAgent: "plan",
            updatedAt: 20,
          }),
        ],
        sessionSnapshot: null,
      }),
    ).toBe("plan")
  })

  test("switching sessions uses the newly active session agent even before the new snapshot loads", () => {
    expect(
      resolveCurrentAgent({
        activeSessionId: "session-plan",
        sessions: [
          createSessionSummary({
            id: "session-default",
            currentAgent: "default",
            updatedAt: 10,
          }),
          createSessionSummary({
            id: "session-plan",
            currentAgent: "plan",
            updatedAt: 20,
          }),
        ],
        sessionSnapshot: {
          session: createSessionSummary({
            id: "session-default",
            currentAgent: "default",
            updatedAt: 10,
          }),
          latestRun: null,
          activeRun: null,
          contextUsage: null,
          status: "idle",
        },
      }),
    ).toBe("plan")
  })

  test("new top-level sessions fall back to general when backend data has no explicit agent yet", () => {
    expect(
      resolveCurrentAgent({
        activeSessionId: "session-new",
        sessions: [
          createSessionSummary({
            id: "session-new",
            currentAgent: undefined,
            updatedAt: 30,
          }),
        ],
        sessionSnapshot: null,
      }),
    ).toBe(DEFAULT_AGENT_NAME)
  })
})

describe("desktop agent wiring", () => {
  test("useDesktopApp derives currentAgent from the active session and backend snapshot data", () => {
    const source = readFileSync("src/desktop/src/useDesktopApp.ts", "utf8")

    expect(source).toContain("const currentAgent = resolveCurrentAgent({")
    expect(source).toContain("activeSessionId: state.activeSessionId,")
    expect(source).toContain("sessions: state.sessions,")
    expect(source).toContain("sessionSnapshot: state.sessionSnapshot,")
    expect(source).toContain("if (input.activeSessionId) {")
    expect(source).toContain("const activeSession = input.sessions.find((session) => session.id === input.activeSessionId)")
    expect(source).toContain("return DEFAULT_AGENT_NAME")
  })

  test("useAgent exposes currentAgent and setCurrentAgent from desktop state", () => {
    const source = readFileSync("src/desktop/src/hooks/useAgent.ts", "utf8")

    expect(source).toContain("const setCurrentAgent = (agentName: string) => {")
    expect(source).toContain("currentAgent: desktop.currentAgent")
    expect(source).toContain("setCurrentAgent,")
    expect(source).toContain("setCurrentAgent(agentName)")
    expect(source).toContain("const next = getNextPrimaryAgent(desktop.currentAgent, desktop.primaryAgents)")
  })
})

function createSessionSummary(input: {
  id: string
  currentAgent?: string
  updatedAt: number
}) {
  return {
    id: input.id,
    directory: "/workspace/alpha",
    workspaceRoot: "/workspace/alpha",
    createdAt: 1,
    title: input.id,
    updatedAt: input.updatedAt,
    latestUserMessagePreview: null,
    activeSkills: [],
    currentAgent: input.currentAgent,
    latestRunStatus: null,
  }
}
