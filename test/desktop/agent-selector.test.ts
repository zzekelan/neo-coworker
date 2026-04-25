import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { listPrimaryBuiltinAgents } from "../../src/agent/domain/builtin-agents"

describe("agent badge component", () => {
  const source = readFileSync("src/desktop/src/components/AgentBadge.tsx", "utf8")

  test("renders with data-testid for Playwright targeting", () => {
    expect(source).toContain('data-testid="agent-badge"')
  })

  test("displays agent label from props", () => {
    expect(source).toContain("agentLabel: string")
    expect(source).toContain("{agentLabel}")
  })

  test("fires onClick callback when clicked", () => {
    expect(source).toContain("onClick={onClick}")
  })

  test("uses React.memo for performance", () => {
    expect(source).toContain("export const AgentBadge = React.memo(AgentBadgeComponent)")
  })

  test("uses CSS variable-based theme classes", () => {
    expect(source).toContain("bg-surface")
    expect(source).toContain("text-ink")
    expect(source).toContain("text-accent")
    expect(source).toContain("bg-highlight")
  })

  test("visually indicates open state", () => {
    expect(source).toContain("isOpen")
    expect(source).toMatch(/isOpen\s*\?\s*"bg-surface text-ink"/)
  })
})

describe("agent selector component", () => {
  const source = readFileSync("src/desktop/src/components/AgentSelector.tsx", "utf8")

  test("renders with data-testid for Playwright targeting", () => {
    expect(source).toContain('data-testid="agent-selector"')
  })

  test("renders individual agent options with data-testid", () => {
    expect(source).toContain("data-testid={`agent-option-${agent.name}`}")
  })

  test("lists only agents passed via props (primary agents)", () => {
    expect(source).toContain("agents.map((agent)")
    expect(source).toContain("const agentLabel = agent.displayName || agent.name")
    expect(source).toContain("{agentLabel}")
  })

  test("highlights current agent with accent color", () => {
    expect(source).toContain("agent.name === currentAgent")
    expect(source).toContain("bg-highlight")
  })

  test("calls onSelect with agent name on click", () => {
    expect(source).toContain("onClick={() => onSelect(agent.name)}")
  })

  test("keeps the selector as a plain compact popup without animation helpers", () => {
    expect(source).not.toContain("framer-motion")
    expect(source).not.toContain("AnimatePresence")
    expect(source).not.toContain("motion.")
    expect(source).not.toContain("transition=")
  })

  test("uses React.memo for performance", () => {
    expect(source).toContain("export const AgentSelector = React.memo(AgentSelectorComponent)")
  })

  test("shows user-facing display names while keeping stable ids", () => {
    expect(source).toContain("const agentLabel = agent.displayName || agent.name")
    expect(source).toContain("{agentLabel}")
    expect(source).toContain("onClick={() => onSelect(agent.name)}")
    expect(source).not.toContain("agent.description || agent.name")
  })

  test("primary agent options have exact display labels and exclude source researcher", () => {
    const primaryAgents = listPrimaryBuiltinAgents()

    expect(primaryAgents.map((agent) => ({ name: agent.name, displayName: agent.displayName }))).toEqual([
      { name: "general", displayName: "General" },
      { name: "plan", displayName: "Plan" },
      { name: "deep-research", displayName: "Deep Research" },
    ])
    expect(primaryAgents.map((agent) => agent.name)).not.toContain("source-researcher")
    expect(primaryAgents.map((agent) => agent.displayName)).not.toContain("Source Researcher")
  })

  test("primary selector labels do not use long descriptions as option text", () => {
    const primaryAgents = listPrimaryBuiltinAgents()

    expect(primaryAgents.map((agent) => agent.description)).toEqual([
      "General-purpose assistant",
      "Strategic planning mode — read-only, no code modifications",
      "Deep Research",
    ])
    expect(primaryAgents.map((agent) => agent.description)).not.toEqual(
      primaryAgents.map((agent) => agent.displayName),
    )
  })
})

describe("agent badge and selector integration in ChatArea", () => {
  const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

  test("imports AgentBadge and AgentSelector", () => {
    expect(source).toContain('import { AgentBadge } from "./AgentBadge"')
    expect(source).toContain('import { AgentSelector } from "./AgentSelector"')
  })

  test("accepts currentAgent, primaryAgents, and onSetAgent props", () => {
    expect(source).toContain("currentAgent: string")
    expect(source).toContain("primaryAgents: DesktopPrimaryAgent[]")
    expect(source).toContain("onSetAgent: (agentName: string) => void")
  })

  test("renders AgentBadge with current agent label and toggle handler", () => {
    expect(source).toContain("<AgentBadge")
    expect(source).toContain("const currentAgentLabel =")
    expect(source).toContain("agentLabel={currentAgentLabel}")
    expect(source).toContain("isOpen={isAgentSelectorOpen}")
    expect(source).toContain("?.displayName || currentAgent")
    expect(source).not.toContain("?.description || currentAgent")
  })

  test("renders AgentSelector with agents and selection handler", () => {
    expect(source).toContain("<AgentSelector")
    expect(source).toContain("agents={primaryAgents}")
    expect(source).toContain("currentAgent={currentAgent}")
    expect(source).toContain("onSelect={handleAgentSelect}")
  })

  test("renders AgentBadge inside the form toolbar for proper layout flow", () => {
    const formOpenIndex = source.indexOf("<motion.form")
    const formCloseIndex = source.indexOf("</motion.form>")
    const badgeIndex = source.indexOf("<AgentBadge")
    expect(badgeIndex).toBeGreaterThan(formOpenIndex)
    expect(badgeIndex).toBeLessThan(formCloseIndex)
    expect(source).toContain("agentSelectorShellRef")
  })

  test("positions badge in a toolbar row below the textarea", () => {
    expect(source).toContain("flex items-center justify-between")
    expect(source).toContain("agentSelectorShellRef")
  })

  test("closes agent selector on outside click via mousedown listener", () => {
    expect(source).toContain("isAgentSelectorOpen")
    expect(source).toContain("agentSelectorShellRef")
    expect(source).toContain('window.addEventListener("mousedown"')
  })

  test("closes agent selector on Escape via close-overlays event", () => {
    expect(source).toContain('window.addEventListener("close-overlays"')
  })

  test("closes agent selector on session change", () => {
    expect(source).toContain("setIsAgentSelectorOpen(false)")
  })

  test("handleAgentSelect persists the stable agent id and closes selector", () => {
    expect(source).toContain("const handleAgentSelect = useCallback((agentName: string)")
    expect(source).toContain("onSetAgent(agentName)")
    expect(source).toContain("setIsAgentSelectorOpen(false)")
  })
})

describe("agent props wiring in App.tsx", () => {
  const source = readFileSync("src/desktop/src/App.tsx", "utf8")

  test("destructures currentAgent, primaryAgents, setAgent from useAgent", () => {
    expect(source).toContain("currentAgent,")
    expect(source).toContain("primaryAgents,")
    expect(source).toContain("setAgent,")
  })

  test("passes agent props to ChatArea", () => {
    expect(source).toContain("currentAgent={currentAgent}")
    expect(source).toContain("primaryAgents={primaryAgents}")
    expect(source).toContain("onSetAgent={setAgent}")
  })
})

describe("useAgent hook exposes setAgent", () => {
  const source = readFileSync("src/desktop/src/hooks/useAgent.ts", "utf8")

  test("exposes setAgent method that calls setSessionAgent", () => {
    expect(source).toContain("setAgent(agentName: string)")
    expect(source).toContain("desktop.setSessionAgent(sessionId, agentName)")
  })

  test("exposes currentAgent from session snapshot", () => {
    expect(source).toContain("currentAgent: desktop.currentAgent")
  })

  test("exposes primaryAgents mapped from desktop state", () => {
    expect(source).toContain("primaryAgents: desktop.primaryAgents.map(mapPrimaryAgent)")
  })
})
