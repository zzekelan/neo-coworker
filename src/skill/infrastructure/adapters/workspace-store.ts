import { randomUUID } from "node:crypto"
import { existsSync, type Dirent } from "node:fs"
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import {
  getSkillCatalogPath,
  LEGACY_SKILLS_DIRECTORY,
  parseSkillMetadata,
  SKILLS_DIRECTORY,
  SKILL_FILENAME,
  SKILL_METADATA_BYTES,
} from "../../domain"
import type {
  LoadedSkill,
  SkillCatalogEntry,
  SkillStore,
} from "../../application/ports/store"

function getSkillsDirectoryName(workspaceRoot: string) {
  const nextDirectory = resolve(workspaceRoot, SKILLS_DIRECTORY)
  const legacyDirectory = resolve(workspaceRoot, LEGACY_SKILLS_DIRECTORY)

  if (!existsSync(nextDirectory) && existsSync(legacyDirectory)) {
    return LEGACY_SKILLS_DIRECTORY
  }

  return SKILLS_DIRECTORY
}

function getSkillsDirectory(workspaceRoot: string) {
  return resolve(workspaceRoot, getSkillsDirectoryName(workspaceRoot))
}

async function resolveSkillCatalogPath(workspaceRoot: string, skillPath: string) {
  const workspace = await realpath(resolve(workspaceRoot))
  const allowedRoots = [
    resolve(workspace, SKILLS_DIRECTORY),
    resolve(workspace, LEGACY_SKILLS_DIRECTORY),
  ]
  const file = await realpath(resolve(workspace, skillPath))

  if (!allowedRoots.some((root) => file === root || file.startsWith(`${root}${sep}`))) {
    throw new Error(
      `Skill must stay inside ${SKILLS_DIRECTORY} or ${LEGACY_SKILLS_DIRECTORY}: ${skillPath}`,
    )
  }

  return file
}

async function resolveSkillFile(workspaceRoot: string, skillName: string) {
  return await resolveSkillCatalogPath(
    workspaceRoot,
    getSkillCatalogPath(skillName, getSkillsDirectoryName(workspaceRoot)),
  )
}

async function resolveSkillCatalogWritePath(workspaceRoot: string, skillPath: string) {
  const workspace = await realpath(resolve(workspaceRoot))
  const allowedRoots = [
    resolve(workspace, SKILLS_DIRECTORY),
    resolve(workspace, LEGACY_SKILLS_DIRECTORY),
  ]
  const file = resolve(workspace, skillPath)

  if (!allowedRoots.some((root) => file === root || file.startsWith(`${root}${sep}`))) {
    throw new Error(
      `Skill must stay inside ${SKILLS_DIRECTORY} or ${LEGACY_SKILLS_DIRECTORY}: ${skillPath}`,
    )
  }

  return file
}

async function readSkillMetadata(
  workspaceRoot: string,
  skillPath: string,
  fallbackName: string,
) {
  const file = await resolveSkillCatalogPath(workspaceRoot, skillPath)
  const text = (await readFile(file)).subarray(0, SKILL_METADATA_BYTES).toString("utf8")

  return parseSkillMetadata(text, fallbackName)
}

async function loadSkillFromPath(
  workspaceRoot: string,
  skillPath: string,
): Promise<LoadedSkill> {
  const file = await resolveSkillCatalogPath(workspaceRoot, skillPath)
  const instructions = await readFile(file, "utf8")
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

async function maybeReadSkillMetadata(
  workspaceRoot: string,
  skillPath: string,
  fallbackName: string,
) {
  try {
    return await readSkillMetadata(workspaceRoot, skillPath, fallbackName)
  } catch (error) {
    if (shouldSkipCatalogEntryError(error)) {
      return null
    }

    throw error
  }
}

async function readCatalogEntriesForDirectory(
  workspaceRoot: string,
  skillsDirectory: string,
  skillsDirectoryName: string,
  directoryEntry: Dirent,
) {
  const directSkillPath = getSkillCatalogPath(directoryEntry.name, skillsDirectoryName)
  const directMetadata = await maybeReadSkillMetadata(workspaceRoot, directSkillPath, directoryEntry.name)

  if (directMetadata) {
    return [
      {
        ...directMetadata,
        path: directSkillPath,
      },
    ] satisfies SkillCatalogEntry[]
  }

  let nestedEntries: Dirent[]
  try {
    nestedEntries = await readdir(resolve(skillsDirectory, directoryEntry.name), {
      withFileTypes: true,
    })
  } catch (error) {
    if (shouldSkipCatalogEntryError(error)) {
      return []
    }

    throw error
  }

  const catalogEntries: SkillCatalogEntry[] = []

  for (const nestedEntry of nestedEntries) {
    if (!nestedEntry.isDirectory() && !nestedEntry.isSymbolicLink()) {
      continue
    }

    const nestedSkillPath = `${skillsDirectoryName}/${directoryEntry.name}/${nestedEntry.name}/${SKILL_FILENAME}`
    const nestedMetadata = await maybeReadSkillMetadata(workspaceRoot, nestedSkillPath, nestedEntry.name)

    if (!nestedMetadata) {
      continue
    }

    catalogEntries.push({
      ...nestedMetadata,
      path: nestedSkillPath,
    })
  }

  return catalogEntries
}

async function writeSkillFile(file: string, content: string) {
  const directory = dirname(file)
  const tempFile = join(directory, `.${basename(file)}.tmp.${randomUUID()}`)

  await mkdir(directory, { recursive: true })

  try {
    await writeFile(tempFile, content, "utf8")
    await rename(tempFile, file)
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined)
    throw error
  }
}

async function removeEmptySkillCategoryDirectory(workspaceRoot: string, skillDirectory: string) {
  const workspace = await realpath(resolve(workspaceRoot))
  const allowedRoots = [
    resolve(workspace, SKILLS_DIRECTORY),
    resolve(workspace, LEGACY_SKILLS_DIRECTORY),
  ]
  const parentDirectory = dirname(skillDirectory)

  const owningRoot = allowedRoots.find(
    (root) => skillDirectory === root || skillDirectory.startsWith(`${root}${sep}`),
  )

  if (!owningRoot || parentDirectory === owningRoot) {
    return
  }

  try {
    const entries = await readdir(parentDirectory)
    if (entries.length === 0) {
      await rm(parentDirectory, { recursive: true, force: true })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return
    }

    throw error
  }
}

export function createWorkspaceSkillStore(): SkillStore {
  return {
    async listCatalog(workspaceRoot: string): Promise<SkillCatalogEntry[]> {
      const skillsDirectoryName = getSkillsDirectoryName(workspaceRoot)
      const skillsDirectory = getSkillsDirectory(workspaceRoot)

      let entries: Dirent[]
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

        catalog.push(
          ...(await readCatalogEntriesForDirectory(
            workspaceRoot,
            skillsDirectory,
            skillsDirectoryName,
            entry,
          )),
        )
      }

      return catalog.sort((left, right) => left.name.localeCompare(right.name))
    },
    loadByPath(workspaceRoot: string, skillPath: string) {
      return loadSkillFromPath(workspaceRoot, skillPath)
    },
    async loadByName(workspaceRoot: string, skillName: string) {
      const file = await resolveSkillFile(workspaceRoot, skillName)
      const instructions = await readFile(file, "utf8")
      const metadata = parseSkillMetadata(instructions, skillName)

      return {
        ...metadata,
        path: getSkillCatalogPath(skillName),
        instructions,
      }
    },
    async writeSkill(workspaceRoot: string, skillPath: string, content: string) {
      const file = await resolveSkillCatalogWritePath(workspaceRoot, skillPath)
      await writeSkillFile(file, content)
    },
    async deleteSkill(workspaceRoot: string, skillPath: string) {
      const file = await resolveSkillCatalogPath(workspaceRoot, skillPath)
      const skillDirectory = dirname(file)

      await rm(skillDirectory, { recursive: true, force: true })
      await removeEmptySkillCategoryDirectory(workspaceRoot, skillDirectory)
    },
  }
}

export {
  getSkillsDirectory,
  readSkillMetadata,
  resolveSkillCatalogPath,
  resolveSkillCatalogWritePath,
  resolveSkillFile,
}
