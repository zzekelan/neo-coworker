import type { AgentProfile } from "./agent-profile"

export type BuiltinAgentProfile = AgentProfile & {
  isPrimary?: boolean
  temperature?: number
}

const PLAN_MODE_INSTRUCTIONS = [
  "You are in strategic planning mode.",
  "Focus on understanding the request, inspecting available context, and producing a clear implementation plan before execution.",
  "Do not make code changes or use mutating tools.",
  "Use read-only investigation, surface assumptions and risks, and finish with concrete next steps.",
].join(" ")

export const BUILTIN_AGENTS: Record<string, BuiltinAgentProfile> = {
  default: {
    name: "default",
    description: "General-purpose assistant",
    isPrimary: true,
    temperature: 1,
    skills: [],
  },
  plan: {
    name: "plan",
    description: "Strategic planning mode — read-only, no code modifications",
    isPrimary: true,
    temperature: 1,
    disallowedTools: ["shell", "edit", "write", "create_skill", "patch_skill", "delete_skill"],
    instructions: PLAN_MODE_INSTRUCTIONS,
    skills: [],
  },
  explore: {
    name: "explore",
    description: "Read-only exploration agent for codebase analysis",
    tools: [
      "read",
      "grep",
      "glob",
      "lsp_symbols",
      "lsp_goto_definition",
      "lsp_find_references",
    ],
    parallel: true,
    skills: [],
  },
  websearch: {
    name: "websearch",
    description: "Web research agent for searching and fetching online information",
    tools: [
      "websearch",
      "webfetch",
    ],
    parallel: true,
    skills: [],
  },
}

export function getBuiltinAgent(name: string): BuiltinAgentProfile | undefined {
  return BUILTIN_AGENTS[name]
}

export function listPrimaryBuiltinAgents(): BuiltinAgentProfile[] {
  return Object.values(BUILTIN_AGENTS).filter((agent) => agent.isPrimary === true)
}
