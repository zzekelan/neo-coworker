import type { AgentProfile } from "../domain"

type MergeableAgentProfile = Partial<AgentProfile>

type AgentProfileLayerLoader = () => Promise<ReadonlyArray<MergeableAgentProfile>>

type LegacyAgentProfileLoader = () => Promise<AgentProfile[]>

type CachedAgentProfiles = {
  profiles: AgentProfile[]
  byName: Map<string, AgentProfile>
}

export interface AgentProfileService {
  loadProfiles(): Promise<AgentProfile[]>
  getProfile(name: string): Promise<AgentProfile | undefined>
  listProfiles(): Promise<string[]>
  getResolvedProfile(name: string): Promise<AgentProfile | undefined>
  listPrimaryAgents(): Promise<AgentProfile[]>
  reload(): void
}

export type CreateAgentProfileServiceInput = {
  builtinAgents: Record<string, AgentProfile> | ReadonlyArray<AgentProfile>
  loadYamlProfiles: AgentProfileLayerLoader
  loadMarkdownProfiles: AgentProfileLayerLoader
  reloadSources?: () => void
}

export function createAgentProfileService(
  input: CreateAgentProfileServiceInput | LegacyAgentProfileLoader,
): AgentProfileService {
  let cache: Promise<CachedAgentProfiles> | null = null

  async function loadCachedProfiles(): Promise<CachedAgentProfiles> {
    if (cache === null) {
      cache = resolveAgentProfiles(normalizeCreateInput(input)).catch((error) => {
        cache = null
        throw error
      })
    }

    return cache
  }

  async function loadProfiles(): Promise<AgentProfile[]> {
    return (await loadCachedProfiles()).profiles
  }

  async function getResolvedProfile(name: string): Promise<AgentProfile | undefined> {
    return (await loadCachedProfiles()).byName.get(name)
  }

  return {
    loadProfiles,
    getProfile(name: string): Promise<AgentProfile | undefined> {
      return getResolvedProfile(name)
    },
    async listProfiles(): Promise<string[]> {
      const profiles = await loadProfiles()
      return profiles.map((p) => p.name)
    },
    getResolvedProfile,
    async listPrimaryAgents(): Promise<AgentProfile[]> {
      const profiles = await loadProfiles()
      return profiles.filter((profile) => profile.isPrimary === true)
    },
    reload(): void {
      cache = null
      if (typeof input !== "function") {
        input.reloadSources?.()
      }
    },
  }
}

function normalizeCreateInput(
  input: CreateAgentProfileServiceInput | LegacyAgentProfileLoader,
): CreateAgentProfileServiceInput {
  if (typeof input !== "function") {
    return input
  }

  return {
    builtinAgents: [],
    loadYamlProfiles: async () => [],
    loadMarkdownProfiles: input,
  }
}

async function resolveAgentProfiles(
  input: CreateAgentProfileServiceInput,
): Promise<CachedAgentProfiles> {
  const [yamlProfiles, markdownProfiles] = await Promise.all([
    input.loadYamlProfiles(),
    input.loadMarkdownProfiles(),
  ])

  const profiles = mergeAgentProfileLayers(
    normalizeBuiltinAgents(input.builtinAgents),
    yamlProfiles,
    markdownProfiles,
  )

  return {
    profiles,
    byName: new Map(profiles.map((profile) => [profile.name, profile])),
  }
}

function normalizeBuiltinAgents(
  builtinAgents: CreateAgentProfileServiceInput["builtinAgents"],
): AgentProfile[] {
  return Array.isArray(builtinAgents) ? [...builtinAgents] : Object.values(builtinAgents)
}

function mergeAgentProfileLayers(
  ...layers: ReadonlyArray<ReadonlyArray<MergeableAgentProfile>>
): AgentProfile[] {
  const mergedProfiles = new Map<string, MergeableAgentProfile>()

  for (const layer of layers) {
    for (const profile of layer) {
      if (!profile.name) {
        continue
      }

      mergedProfiles.set(profile.name, {
        ...(mergedProfiles.get(profile.name) ?? {}),
        ...profile,
        name: profile.name,
      })
    }
  }

  return [...mergedProfiles.values()].map((profile) => sanitizePrimaryAgentTools(profile))
}

function sanitizePrimaryAgentTools(profile: MergeableAgentProfile): AgentProfile {
  if (profile.isPrimary !== true || profile.tools === undefined) {
    return profile as AgentProfile
  }

  const { tools: _tools, ...rest } = profile
  return rest as AgentProfile
}
