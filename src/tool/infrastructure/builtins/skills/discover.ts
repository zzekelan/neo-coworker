import { readdir } from "node:fs/promises"
import {
  getSkillCatalogPath,
  getSkillsDirectory,
  readSkillMetadata,
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
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue
    }

    const skillPath = getSkillCatalogPath(entry.name)
    const metadata = await readSkillMetadata(workspaceRoot, skillPath, entry.name)

    catalog.push({
      ...metadata,
      path: skillPath,
    })
  }

  return catalog.sort((left, right) => left.name.localeCompare(right.name))
}
