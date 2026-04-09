import type { AgentProfile } from "./agent-profile"

export const BUILTIN_AGENTS: Record<string, AgentProfile> = {
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

export function getBuiltinAgent(name: string): AgentProfile | undefined {
  return BUILTIN_AGENTS[name]
}
