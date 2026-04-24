import { randomUUID } from "node:crypto"
import { existsSync, type Dirent } from "node:fs"
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
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

const SUPPORT_DIRECTORIES = ["assets", "examples", "references", "scripts"] as const

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
  assertSkillEntrypointPath(skillPath)
  const file = await resolveSkillCatalogPath(workspaceRoot, skillPath)
  const packageDirectory = dirname(file)
  const instructions = await readFile(file, "utf8")
  const metadata = parseSkillMetadata(instructions, skillPath.split("/").at(-2) ?? skillPath)

  return {
    ...metadata,
    path: skillPath,
    entryPath: SKILL_FILENAME,
    baseDir: pathToFileURL(`${packageDirectory}${sep}`).href,
    source: resolveSkillSource(skillPath),
    files: await listSupportFiles(packageDirectory),
    instructions,
  }
}

function assertSkillEntrypointPath(skillPath: string) {
  const normalizedPath = skillPath.split(sep).join("/")
  const nextPrefix = `${SKILLS_DIRECTORY}/`
  const legacyPrefix = `${LEGACY_SKILLS_DIRECTORY}/`
  const relativePath = normalizedPath.startsWith(nextPrefix)
    ? normalizedPath.slice(nextPrefix.length)
    : normalizedPath.startsWith(legacyPrefix)
      ? normalizedPath.slice(legacyPrefix.length)
      : null
  const parts = relativePath?.split("/") ?? []

  if (
    relativePath &&
    (parts.length === 2 || parts.length === 3) &&
    parts.every((part) => part.length > 0) &&
    parts.at(-1) === SKILL_FILENAME
  ) {
    return
  }

  throw new Error(`Skill entrypoint must be ${SKILL_FILENAME}: ${skillPath}`)
}

function resolveSkillSource(skillPath: string) {
  if (skillPath.startsWith(`${SKILLS_DIRECTORY}/`) || skillPath.startsWith(`${LEGACY_SKILLS_DIRECTORY}/`)) {
    return "workspace" as const
  }

  return "workspace" as const
}

async function listSupportFiles(packageDirectory: string) {
  const packageRoot = await realpath(packageDirectory)
  const files: string[] = []
  const visitedDirectories = new Set<string>()

  for (const supportDirectory of SUPPORT_DIRECTORIES) {
    const absoluteDirectory = join(packageRoot, supportDirectory)
    const realDirectory = await safeRealpath(absoluteDirectory)
    if (!realDirectory || !isInsideDirectory(realDirectory, packageRoot)) {
      continue
    }

    await collectSupportFiles({
      packageRoot,
      directory: absoluteDirectory,
      relativeDirectory: supportDirectory,
      files,
      visitedDirectories,
    })
  }

  return files.sort((left, right) => left.localeCompare(right))
}

async function collectSupportFiles(input: {
  packageRoot: string
  directory: string
  relativeDirectory: string
  files: string[]
  visitedDirectories: Set<string>
}) {
  const realDirectory = await safeRealpath(input.directory)
  if (!realDirectory || !isInsideDirectory(realDirectory, input.packageRoot)) {
    return
  }

  if (input.visitedDirectories.has(realDirectory)) {
    return
  }
  input.visitedDirectories.add(realDirectory)

  let entries: Dirent[]
  try {
    entries = await readdir(input.directory, { withFileTypes: true })
  } catch (error) {
    if (shouldSkipCatalogEntryError(error)) {
      return
    }

    throw error
  }

  for (const entry of entries) {
    const absolutePath = join(input.directory, entry.name)
    const relativePath = `${input.relativeDirectory}/${entry.name}`
    const realPath = await safeRealpath(absolutePath)

    if (!realPath || !isInsideDirectory(realPath, input.packageRoot)) {
      continue
    }

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (await isDirectoryPath(absolutePath)) {
        await collectSupportFiles({
          packageRoot: input.packageRoot,
          directory: absolutePath,
          relativeDirectory: relativePath,
          files: input.files,
          visitedDirectories: input.visitedDirectories,
        })
        continue
      }
    }

    if (entry.isFile() || entry.isSymbolicLink()) {
      input.files.push(relativePath)
    }
  }
}

async function safeRealpath(path: string) {
  try {
    return await realpath(path)
  } catch (error) {
    if (shouldSkipCatalogEntryError(error)) {
      return null
    }

    throw error
  }
}

async function isDirectoryPath(path: string) {
  try {
    const resolved = await realpath(path)
    const entries = await readdir(resolved, { withFileTypes: true })
    void entries
    return true
  } catch (error) {
    if (shouldSkipCatalogEntryError(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return false
    }

    throw error
  }
}

function isInsideDirectory(file: string, directory: string) {
  return file === directory || file.startsWith(`${directory}${sep}`)
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
      await resolveSkillFile(workspaceRoot, skillName)
      return loadSkillFromPath(
        workspaceRoot,
        getSkillCatalogPath(skillName, getSkillsDirectoryName(workspaceRoot)),
      )
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
