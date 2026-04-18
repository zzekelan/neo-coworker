import type { AgentProfile } from "../domain/agent-profile"

export function isToolAllowedForAgent(toolName: string, profile: AgentProfile): boolean {
  const disallowedTools = normalizePatterns(profile.disallowedTools)
  if (disallowedTools.length === 0) {
    return true
  }

  return disallowedTools.every((pattern) => !matchesToolPattern(toolName, pattern))
}

export function buildToolDeniedMessage(toolName: string, agentName: string): string {
  return `Tool '${toolName}' is not available in ${agentName} mode. Switch to default mode to use this tool.`
}

function normalizePatterns(patterns?: string[]) {
  return (patterns ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0)
}

function matchesToolPattern(toolName: string, pattern: string) {
  if (!pattern.includes("*")) {
    return toolName === pattern
  }

  const matcher = new RegExp(`^${escapeRegex(pattern).replaceAll("\\*", ".*")}$`)
  return matcher.test(toolName)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
