import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "yaml"
import { z } from "zod"
import { AgentProfileSchema } from "../domain"
import { listPrimaryBuiltinAgents } from "../domain/builtin-agents"
import type { AgentProfile } from "../domain"

const AGENTS_YAML_PATH = ".ncoworker/agents.yaml"

type PartialAgentProfile = Partial<AgentProfile> & {
  name: string
  temperature?: number
  isPrimary?: boolean
}

const yamlAgentConfigCache = new Map<string, Promise<PartialAgentProfile[]>>()
const primaryBuiltinAgentNames = new Set(
  listPrimaryBuiltinAgents().map((agent) => agent.name),
)

const AgentsYamlFileSchema = z.object({
  agents: z.record(z.string(), z.unknown()),
})

const PartialAgentProfileSchema = AgentProfileSchema.omit({
  name: true,
  skills: true,
})
  .partial()
  .extend({
    name: z.string().optional(),
    skills: z.array(z.string()).optional(),
  })

export function clearYamlAgentConfigCache(workspaceRoot?: string): void {
  if (workspaceRoot) {
    yamlAgentConfigCache.delete(workspaceRoot)
    return
  }

  yamlAgentConfigCache.clear()
}

export async function loadYamlAgentConfig(
  workspaceRoot: string,
): Promise<Partial<AgentProfile>[]> {
  let cached = yamlAgentConfigCache.get(workspaceRoot)

  if (!cached) {
    cached = readYamlAgentConfig(workspaceRoot).catch((error) => {
      yamlAgentConfigCache.delete(workspaceRoot)
      throw error
    })

    yamlAgentConfigCache.set(workspaceRoot, cached)
  }

  return cached
}

async function readYamlAgentConfig(workspaceRoot: string): Promise<PartialAgentProfile[]> {
  const filePath = join(workspaceRoot, AGENTS_YAML_PATH)

  let content: string
  try {
    content = await readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }

    throw error
  }

  let parsed: unknown
  try {
    parsed = parse(content)
  } catch (error) {
    console.warn(`[yaml-config-loader] Invalid YAML in ${filePath}: ${getErrorMessage(error)}`)
    return []
  }

  const fileResult = AgentsYamlFileSchema.safeParse(parsed)
  if (!fileResult.success) {
    console.warn(
      `[yaml-config-loader] Invalid config in ${filePath}: ${fileResult.error.message}`,
    )
    return []
  }

  const profiles: PartialAgentProfile[] = []

  for (const [name, rawProfile] of Object.entries(fileResult.data.agents)) {
    if (!isPlainObject(rawProfile)) {
      console.warn(
        `[yaml-config-loader] Skipping agent '${name}' in ${filePath}: expected a mapping.`,
      )
      continue
    }

    const result = PartialAgentProfileSchema.safeParse({
      ...rawProfile,
      name,
    })

    if (!result.success) {
      console.warn(
        `[yaml-config-loader] Skipping invalid agent '${name}' in ${filePath}: ${result.error.message}`,
      )
      continue
    }

    profiles.push(stripToolsFromPrimaryAgent(result.data as PartialAgentProfile, filePath))
  }

  return profiles
}

function stripToolsFromPrimaryAgent(
  profile: PartialAgentProfile,
  filePath: string,
): PartialAgentProfile {
  const isPrimary = profile.isPrimary === true || primaryBuiltinAgentNames.has(profile.name)
  if (!isPrimary || profile.tools === undefined) {
    return profile
  }

  console.warn(
    `[yaml-config-loader] Ignoring tools for primary agent '${profile.name}' in ${filePath}.`,
  )

  const { tools: _tools, ...rest } = profile
  return rest
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
