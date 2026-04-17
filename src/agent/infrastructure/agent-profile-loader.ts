import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { AgentProfileSchema } from "../domain"
import { BUILTIN_AGENTS } from "../domain/builtin-agents"
import type { AgentProfile } from "../domain"
import { loadYamlAgentConfig } from "./yaml-config-loader"

const bunRuntime = globalThis as typeof globalThis & {
  Bun: {
    file(path: string): {
      text(): Promise<string>
    }
  }
}

const AGENTS_DIRECTORY = ".ncoworker/agents"

type MergeableAgentProfile = Partial<AgentProfile> & {
  name: string
  temperature?: number
  isPrimary?: boolean
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  const block = match[1]
  const result: Record<string, unknown> = {}

  const lines = block.split("\n")
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)

    if (!keyMatch) {
      i++
      continue
    }

    const key = keyMatch[1]
    const rawValue = keyMatch[2].trim()

    if (rawValue === "") {
      const items: string[] = []
      i++
      while (i < lines.length && lines[i].match(/^\s+-\s+/)) {
        items.push(lines[i].replace(/^\s+-\s+/, "").trim())
        i++
      }
      result[key] = items
      continue
    }

    result[key] = parseScalarValue(rawValue)
    i++
  }

  return result
}

function parseScalarValue(raw: string): unknown {
  if (raw === "true") return true
  if (raw === "false") return false

  const num = Number(raw)
  if (!Number.isNaN(num) && raw !== "") return num

  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1)
    if (inner.trim() === "") return []
    return inner.split(",").map((s) => s.trim())
  }

  return raw
}

export async function loadAgentProfiles(workspaceRoot: string): Promise<AgentProfile[]> {
  const agentsDir = join(workspaceRoot, AGENTS_DIRECTORY)

  let entries
  try {
    entries = await readdir(agentsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw error
  }

  const profiles: AgentProfile[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue
    }

    const filePath = join(agentsDir, entry.name)
    let content: string
    try {
      content = await bunRuntime.Bun.file(filePath).text()
    } catch {
      console.warn(`[agent-profile-loader] Could not read file: ${filePath}`)
      continue
    }

    const parsed = parseFrontmatter(content)
    if (!parsed) {
      console.warn(`[agent-profile-loader] No frontmatter found in: ${filePath}`)
      continue
    }

    const result = AgentProfileSchema.safeParse(parsed)
    if (!result.success) {
      console.warn(
        `[agent-profile-loader] Invalid profile in ${filePath}: ${result.error.message}`,
      )
      continue
    }

    profiles.push(result.data)
  }

  return profiles
}

export async function loadMergedAgentProfiles(workspaceRoot: string): Promise<AgentProfile[]> {
  const [yamlProfiles, markdownProfiles] = await Promise.all([
    loadYamlAgentConfig(workspaceRoot),
    loadAgentProfiles(workspaceRoot),
  ])

  return mergeAgentProfileLayers(
    Object.values(BUILTIN_AGENTS) as MergeableAgentProfile[],
    yamlProfiles as MergeableAgentProfile[],
    markdownProfiles as MergeableAgentProfile[],
  )
}

function mergeAgentProfileLayers(
  ...layers: ReadonlyArray<ReadonlyArray<MergeableAgentProfile>>
): AgentProfile[] {
  const mergedProfiles = new Map<string, MergeableAgentProfile>()

  for (const layer of layers) {
    for (const profile of layer) {
      const merged = sanitizePrimaryAgentTools({
        ...(mergedProfiles.get(profile.name) ?? {}),
        ...profile,
        name: profile.name,
      })

      mergedProfiles.set(profile.name, merged)
    }
  }

  return [...mergedProfiles.values()] as AgentProfile[]
}

function sanitizePrimaryAgentTools(profile: MergeableAgentProfile): MergeableAgentProfile {
  if (profile.isPrimary !== true || profile.tools === undefined) {
    return profile
  }

  console.warn(
    `[agent-profile-loader] Ignoring tools override for primary agent '${profile.name}'.`,
  )

  const { tools: _tools, ...rest } = profile
  return rest
}
