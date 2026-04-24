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

const DEEP_RESEARCH_INSTRUCTIONS = [
  "# Deep Research Workflow",
  "You are the primary Deep Research agent. Produce files-only research artifacts under `.ncoworker/research/**`; do not use ad hoc transcript-only findings as the durable record.",
  "Follow topic reuse and topic update rules: reuse an existing topic directory when the user's request matches prior scope, aliases, or open questions; otherwise create a stable new topic slug. Update the topic brief, findings, open questions, source index, and source records instead of creating duplicate topics.",
  "Plan source collection with adaptive 0-5 Source Researcher subagents based on research breadth and uncertainty. Use zero subagents for narrow or already-supported claims; dispatch up to five focused `source-researcher` subagents through the existing `agent` delegation tool when independent source collection would reduce uncertainty.",
  "Every finding must preserve the research schema fields, including `Claim` and `Evidence`, and distinguish verified facts from unresolved notes.",
  "Record source acceptance, source rejection, and caveats explicitly: accept only sources that are relevant, attributable, and reliable enough for the claim; reject or quarantine sources that are stale, mismatched, unverifiable, or outside allowed source types; capture limitations as caveats.",
  "Allowed source records are limited to web, docs, and files. Keep source notes structured enough to connect each accepted source to related claims and evidence.",
  "Only the primary Deep Research agent writes research artifacts. Subagents return structured/source notes only; they must not write `.ncoworker/research/**` or any durable research artifact directly.",
].join("\n")

const SOURCE_NOTE_SUBAGENT_INSTRUCTIONS = [
  "# Source Note Subagent Contract",
  "You are a Source Researcher subagent for Deep Research. Follow the active `source-note` skill instructions and return structured source notes; do not write `.ncoworker/research/**` or any durable research artifact directly.",
  "Return only source-note candidates for the primary Deep Research agent to evaluate and write. Do not claim acceptance; the primary agent decides whether a note becomes an accepted source, rejected source, caveat, or open question.",
  "Each structured source note must define these fields exactly: proposed type, title, URL/URI/path, retrieved-at, publisher/author, reliability, relevance, supports, contradicts, key excerpts, caveats, suggested tags.",
  "Allowed proposed type values are limited to web, docs, and files. Do not invent source types outside the canonical research schema.",
  "If reliability is low (low reliability), attribution is missing, the source is stale, or the source only weakly supports the claim, mark it as a caveat/open-question candidate and not an accepted source.",
].join("\n")

export const BUILTIN_AGENTS: Record<string, BuiltinAgentProfile> = {
  general: {
    name: "general",
    displayName: "General",
    description: "General-purpose assistant",
    isPrimary: true,
    temperature: 1,
    skills: [],
  },
  plan: {
    name: "plan",
    displayName: "Plan",
    description: "Strategic planning mode — read-only, no code modifications",
    isPrimary: true,
    temperature: 1,
    disallowedTools: [
      "shell",
      "edit",
      "write",
      "memory_add",
      "memory_replace",
      "memory_remove",
      "create_skill",
      "patch_skill",
      "delete_skill",
    ],
    instructions: PLAN_MODE_INSTRUCTIONS,
    skills: [],
  },
  "deep-research": {
    name: "deep-research",
    displayName: "Deep Research",
    description: "Deep Research",
    isPrimary: true,
    temperature: 1,
    instructions: DEEP_RESEARCH_INSTRUCTIONS,
    skills: ["research/deep-research", "research/finding-synthesis"],
  },
  "source-researcher": {
    name: "source-researcher",
    displayName: "Source Researcher",
    description: "Source note collector",
    tools: ["read", "grep", "glob", "webfetch", "get_current_datetime"],
    parallel: true,
    instructions: SOURCE_NOTE_SUBAGENT_INSTRUCTIONS,
    skills: ["source-note"],
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
