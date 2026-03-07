import { readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  getSkillCatalogPath,
  getSkillsDirectory,
  parseSkillMetadata,
  type SkillCatalogEntry,
} from "./catalog"

export async function discoverSkills(workspaceRoot: string): Promise<SkillCatalogEntry[]> {
  const skillsDirectory = getSkillsDirectory(workspaceRoot)

  let entries
  try {
    entries = await readdir(skillsDirectory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }

    throw error
  }

  const catalog: SkillCatalogEntry[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const skillFile = join(skillsDirectory, entry.name, "SKILL.md")
    const text = await Bun.file(skillFile).text()
    const metadata = parseSkillMetadata(text, entry.name)

    catalog.push({
      ...metadata,
      path: getSkillCatalogPath(entry.name),
    })
  }

  return catalog.sort((left, right) => left.name.localeCompare(right.name))
}
