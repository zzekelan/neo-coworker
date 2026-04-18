export type { AgentProfile } from "../application"
export { AgentProfileSchema } from "../application"
export type { AgentProfileInput, AgentProfileOutput } from "../application"
export { BUILTIN_AGENTS, getBuiltinAgent } from "../application"
export { createSubAgentContext, createSubAgentRun, filterToolsForAgent, loadSkillsForAgent } from "../application"
export { buildToolDeniedMessage, isToolAllowedForAgent } from "../application"
export type { CreateSubAgentRunInput } from "../application"
export type { AgentProfileService } from "../application"
export { createAgentTool } from "../infrastructure/agent-tool"
export { loadAgentProfiles, loadMergedAgentProfiles } from "../infrastructure/agent-profile-loader"
export { clearYamlAgentConfigCache, loadYamlAgentConfig } from "../infrastructure/yaml-config-loader"

import { BUILTIN_AGENTS, createAgentProfileService as makeService } from "../application"
import { loadAgentProfiles } from "../infrastructure/agent-profile-loader"
import { clearYamlAgentConfigCache, loadYamlAgentConfig } from "../infrastructure/yaml-config-loader"

export function createAgentProfileService(workspaceRoot: string) {
  return makeService({
    builtinAgents: BUILTIN_AGENTS,
    loadYamlProfiles: () => loadYamlAgentConfig(workspaceRoot),
    loadMarkdownProfiles: () => loadAgentProfiles(workspaceRoot),
    reloadSources: () => clearYamlAgentConfigCache(workspaceRoot),
  })
}
