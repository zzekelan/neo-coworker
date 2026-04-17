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
import { BUILTIN_AGENTS } from "../domain/builtin-agents"
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
