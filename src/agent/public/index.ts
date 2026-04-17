export type { AgentProfile } from "../application"
export { AgentProfileSchema } from "../application"
export type { AgentProfileInput, AgentProfileOutput } from "../application"
export { BUILTIN_AGENTS, getBuiltinAgent } from "../application"
export { createSubAgentContext, createSubAgentRun, filterToolsForAgent, loadSkillsForAgent } from "../application"
export type { CreateSubAgentRunInput } from "../application"
export type { AgentProfileService } from "../application/agent-profile-service"
export { createAgentTool } from "../infrastructure/agent-tool"
export { loadAgentProfiles, loadMergedAgentProfiles } from "../infrastructure/agent-profile-loader"
export { clearYamlAgentConfigCache, loadYamlAgentConfig } from "../infrastructure/yaml-config-loader"

import { createAgentProfileService as makeService } from "../application/agent-profile-service"
import { loadMergedAgentProfiles } from "../infrastructure/agent-profile-loader"

export function createAgentProfileService(workspaceRoot: string) {
  return makeService(() => loadMergedAgentProfiles(workspaceRoot))
}
