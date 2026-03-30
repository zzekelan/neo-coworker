import { readdir, realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import {
  getSkillCatalogPath,
  parseSkillMetadata,
  SKILLS_DIRECTORY,
  SKILL_METADATA_BYTES,
} from "../../domain"
import type {
  LoadedSkill,
  SkillCatalogEntry,
  SkillStore,
} from "../../application/ports/store"

function getSkillsDirectory(workspaceRoot: string) {
  return resolve(workspaceRoot, SKILLS_DIRECTORY)
}

async function resolveSkillCatalogPath(workspaceRoot: string, skillPath: string) {
  const workspace = await realpath(resolve(workspaceRoot))
  const skillsRoot = resolve(workspace, SKILLS_DIRECTORY)
  const file = await realpath(resolve(workspace, skillPath))

  if (file !== skillsRoot && !file.startsWith(`${skillsRoot}${sep}`)) {
    throw new Error(`Skill must stay inside ${SKILLS_DIRECTORY}: ${skillPath}`)
  }

  return file
}

async function resolveSkillFile(workspaceRoot: string, skillName: string) {
  return await resolveSkillCatalogPath(workspaceRoot, getSkillCatalogPath(skillName))
}

async function readSkillMetadata(
  workspaceRoot: string,
  skillPath: string,
  fallbackName: string,
) {
  const file = await resolveSkillCatalogPath(workspaceRoot, skillPath)
  const text = await Bun.file(file).slice(0, SKILL_METADATA_BYTES).text()

  return parseSkillMetadata(text, fallbackName)
}

async function loadSkillFromPath(
  workspaceRoot: string,
  skillPath: string,
): Promise<LoadedSkill> {
  const file = await resolveSkillCatalogPath(workspaceRoot, skillPath)
  const instructions = await Bun.file(file).text()
  const metadata = parseSkillMetadata(instructions, skillPath.split("/").at(-2) ?? skillPath)

  return {
    ...metadata,
    path: skillPath,
    instructions,
  }
}

function shouldSkipCatalogEntryError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === "ENOENT"
}

export function createWorkspaceSkillStore(): SkillStore {
  return {
    async listCatalog(workspaceRoot: string): Promise<SkillCatalogEntry[]> {
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
        let metadata
        try {
          metadata = await readSkillMetadata(workspaceRoot, skillPath, entry.name)
        } catch (error) {
          if (shouldSkipCatalogEntryError(error)) {
            continue
          }

          throw error
        }

        catalog.push({
          ...metadata,
          path: skillPath,
        })
      }

      return catalog.sort((left, right) => left.name.localeCompare(right.name))
    },
    loadByPath(workspaceRoot: string, skillPath: string) {
      return loadSkillFromPath(workspaceRoot, skillPath)
    },
    async loadByName(workspaceRoot: string, skillName: string) {
      const file = await resolveSkillFile(workspaceRoot, skillName)
      const instructions = await Bun.file(file).text()
      const metadata = parseSkillMetadata(instructions, skillName)

      return {
        ...metadata,
        path: getSkillCatalogPath(skillName),
        instructions,
      }
    },
  }
}

export {
  getSkillsDirectory,
  readSkillMetadata,
  resolveSkillCatalogPath,
  resolveSkillFile,
}
