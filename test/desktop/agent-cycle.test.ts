import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { getNextPrimaryAgent } from "../../src/desktop/src/agent-cycle"
import { listPrimaryBuiltinAgents } from "../../src/agent/domain/builtin-agents"

describe("agent cycle logic", () => {
  test("cycles to next agent", () => {
    const agents = [{ name: "default", description: "" }, { name: "plan", description: "" }]
    expect(getNextPrimaryAgent("default", agents)).toBe("plan")
  })

  test("wraps around at end of list", () => {
    const agents = [{ name: "default", description: "" }, { name: "plan", description: "" }]
    expect(getNextPrimaryAgent("plan", agents)).toBe("default")
  })

  test("cycles through Deep Research in primary agent order", () => {
    const agents = [
      { name: "default", description: "General-purpose assistant" },
      { name: "plan", description: "Strategic planning mode — read-only, no code modifications" },
      { name: "deep-research", description: "Deep Research" },
    ]

    expect(getNextPrimaryAgent("plan", agents)).toBe("deep-research")
    expect(getNextPrimaryAgent("deep-research", agents)).toBe("default")
  })

  test("returns first agent when current is unknown", () => {
    const agents = [{ name: "default", description: "" }, { name: "plan", description: "" }]
    expect(getNextPrimaryAgent("unknown", agents)).toBe("default")
  })

  test("returns current agent when list is empty", () => {
    expect(getNextPrimaryAgent("default", [])).toBe("default")
  })

  test("handles single-agent list", () => {
    const agents = [{ name: "default", description: "" }]
    expect(getNextPrimaryAgent("default", agents)).toBe("default")
  })
})

describe("desktop agent cycling integration", () => {
  test("built-in primary agents include Deep Research for desktop cycling", () => {
    expect(listPrimaryBuiltinAgents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "deep-research",
          description: "Deep Research",
          isPrimary: true,
        }),
      ]),
    )
  })

  test("KeyboardShortcutProvider registers shift+tab for agent cycling", () => {
    const source = readFileSync("src/desktop/src/providers/KeyboardShortcutProvider.tsx", "utf8")

    expect(source).toContain('registerShortcut("shift+tab"')
    expect(source).toContain("onCycleAgent")
    expect(source).toContain("isShiftTab")
    expect(source).toContain("event.shiftKey && event.key === \"Tab\"")
  })

  test("KeyboardShortcutProvider allows shift+tab through input-focused guard", () => {
    const source = readFileSync("src/desktop/src/providers/KeyboardShortcutProvider.tsx", "utf8")

    expect(source).toContain("!isShiftTab")
  })

  test("useAgent exposes cycleAgent, currentAgent, and primaryAgents", () => {
    const source = readFileSync("src/desktop/src/hooks/useAgent.ts", "utf8")

    expect(source).toContain("cycleAgent")
    expect(source).toContain("currentAgent")
    expect(source).toContain("primaryAgents")
    expect(source).toContain("getNextPrimaryAgent")
  })

  test("App.tsx passes onCycleAgent to KeyboardShortcutProvider", () => {
    const source = readFileSync("src/desktop/src/App.tsx", "utf8")

    expect(source).toContain("onCycleAgent={cycleAgent}")
  })

  test("api.ts exports loadPrimaryAgents and updateSessionAgent", () => {
    const source = readFileSync("src/desktop/src/api.ts", "utf8")

    expect(source).toContain("export async function loadPrimaryAgents(workspaceRoot?: string)")
    expect(source).toContain("export async function updateSessionAgent(")
    expect(source).toContain("/agents/primary")
    expect(source).toContain("/agent")
  })

  test("agent-cycle module exports getNextPrimaryAgent and PrimaryAgent type", () => {
    const source = readFileSync("src/desktop/src/agent-cycle.ts", "utf8")

    expect(source).toContain("export function getNextPrimaryAgent")
    expect(source).toContain("export type PrimaryAgent")
  })

  test("server exposes GET /agents/primary and POST /sessions/:id/agent routes", () => {
    const source = readFileSync("src/app-server/server.ts", "utf8")

    expect(source).toContain('path === "agents/primary"')
    expect(source).toContain('["sessions", ":sessionId", "agent"]')
    expect(source).toContain("listPrimaryAgentsImpl")
    expect(source).toContain("setCurrentAgentBodySchema")
  })

  test("dev-server-config proxies /agents routes to app-server", () => {
    const source = readFileSync("src/desktop/dev-server-config.ts", "utf8")

    expect(source).toContain("^/agents(?:/.*)?$")
  })
})
