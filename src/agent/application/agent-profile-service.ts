import type { AgentProfile } from "../domain"

export interface AgentProfileService {
  loadProfiles(): Promise<AgentProfile[]>
  getProfile(name: string): Promise<AgentProfile | undefined>
  listProfiles(): Promise<string[]>
}

export function createAgentProfileService(
  loader: () => Promise<AgentProfile[]>,
): AgentProfileService {
  let cache: AgentProfile[] | null = null

  async function loadProfiles(): Promise<AgentProfile[]> {
    if (cache === null) {
      cache = await loader()
    }
    return cache
  }

  return {
    loadProfiles,
    async getProfile(name: string): Promise<AgentProfile | undefined> {
      const profiles = await loadProfiles()
      return profiles.find((p) => p.name === name)
    },
    async listProfiles(): Promise<string[]> {
      const profiles = await loadProfiles()
      return profiles.map((p) => p.name)
    },
  }
}
