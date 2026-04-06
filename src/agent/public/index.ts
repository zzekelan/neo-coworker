export type { AgentProfile } from "../application"
export { AgentProfileSchema } from "../application"
export type { AgentProfileInput, AgentProfileOutput } from "../application"
export type { AgentProfileService } from "../application/agent-profile-service"
export { loadAgentProfiles } from "../infrastructure/agent-profile-loader"

import { createAgentProfileService as makeService } from "../application/agent-profile-service"
import { loadAgentProfiles } from "../infrastructure/agent-profile-loader"

export function createAgentProfileService(workspaceRoot: string) {
  return makeService(() => loadAgentProfiles(workspaceRoot))
}
