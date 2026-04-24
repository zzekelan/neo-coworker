import type { Dirent } from "node:fs"
import { readFile, readdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import {
  parseSkillMetadata,
  SKILLS_DIRECTORY,
  SKILL_FILENAME,
  SKILL_METADATA_BYTES,
} from "../../domain"
import type {
  LoadedSkill,
  SkillCatalogEntry,
  SkillCatalogOverride,
  SkillSource,
  SkillStore,
} from "../../application/ports/store"
import { materializeBuiltinSkills } from "../builtin-materializer"
import { createWorkspaceSkillStore } from "./workspace-store"

const SUPPORT_DIRECTORIES = ["assets", "examples", "references", "scripts"] as const
const APP_DIR_NAME = "neo-coworker"
const GLOBAL_SKILLS_DIRECTORY_NAME = "skills"
const GLOBAL_PATH_PREFIX = "global:"
const BUILTIN_PATH_PREFIX = "builtin:"

type SkillLayer = {
  source: SkillSource
  root: string
  displayRoot?: string
  pathPrefix?: string
}

type LayeredSkillCatalogEntry = SkillCatalogEntry & {
  source: SkillSource
}

export function getGlobalSkillsDirectory(configRoot = getDefaultUserConfigRoot()) {
  return join(configRoot, GLOBAL_SKILLS_DIRECTORY_NAME)
}

function getDefaultUserConfigRoot(env: Record<string, string | undefined> = process.env) {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
  const base = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(homedir(), ".config")
  return join(base, APP_DIR_NAME)
}

export function createLayeredSkillStore(): SkillStore {
  const workspaceStore = createWorkspaceSkillStore()

  return {
    async listCatalog(workspaceRoot) {
      const entries: LayeredSkillCatalogEntry[] = []

      for (const layer of await resolveSkillLayers(workspaceRoot)) {
        entries.push(...(await listLayerCatalog(layer)))
      }

      return selectEffectiveCatalogEntries(entries)
    },
    async loadByPath(workspaceRoot, skillPath) {
      if (skillPath.startsWith(GLOBAL_PATH_PREFIX)) {
        return loadLayerSkill({
          source: "global",
          root: getGlobalSkillsDirectory(),
          pathPrefix: GLOBAL_PATH_PREFIX,
        }, skillPath)
      }

      if (skillPath.startsWith(BUILTIN_PATH_PREFIX)) {
        const materialized = await materializeBuiltinSkills()
        return loadLayerSkill({
          source: "builtin",
          root: materialized.root,
          pathPrefix: BUILTIN_PATH_PREFIX,
        }, skillPath)
      }

      return workspaceStore.loadByPath(workspaceRoot, skillPath)
    },
    async loadByName(workspaceRoot, skillName) {
      const catalog = await this.listCatalog(workspaceRoot)
      const discovered = catalog.find((skill) => skill.name === skillName)

      if (!discovered) {
        return workspaceStore.loadByName(workspaceRoot, skillName)
      }

      return this.loadByPath(workspaceRoot, discovered.path)
    },
    writeSkill(workspaceRoot, skillPath, content) {
      assertWorkspaceWritePath(skillPath)
      return workspaceStore.writeSkill(workspaceRoot, skillPath, content)
    },
    deleteSkill(workspaceRoot, skillPath) {
      assertWorkspaceWritePath(skillPath)
      return workspaceStore.deleteSkill(workspaceRoot, skillPath)
    },
  }
}

async function resolveSkillLayers(workspaceRoot: string): Promise<SkillLayer[]> {
  const materialized = await materializeBuiltinSkills()

  return [
    {
      source: "workspace",
      root: resolve(workspaceRoot, SKILLS_DIRECTORY),
      displayRoot: SKILLS_DIRECTORY,
    },
    {
      source: "global",
      root: getGlobalSkillsDirectory(),
      pathPrefix: GLOBAL_PATH_PREFIX,
    },
    {
      source: "builtin",
      root: materialized.root,
      pathPrefix: BUILTIN_PATH_PREFIX,
    },
  ]
}

async function listLayerCatalog(layer: SkillLayer): Promise<LayeredSkillCatalogEntry[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(layer.root, { withFileTypes: true })
  } catch (error) {
    if (shouldSkipCatalogEntryError(error)) {
      return []
    }

    throw error
  }

  const catalog: LayeredSkillCatalogEntry[] = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue
    }

    catalog.push(...(await readCatalogEntriesForDirectory(layer, entry)))
  }

  return catalog
}

async function readCatalogEntriesForDirectory(layer: SkillLayer, directoryEntry: Dirent) {
  const directSkillPath = `${directoryEntry.name}/${SKILL_FILENAME}`
  const directMetadata = await maybeReadSkillMetadata(layer, directSkillPath, directoryEntry.name)

  if (directMetadata) {
    return [
      {
        ...directMetadata,
        path: formatLayerPath(layer, directSkillPath),
        source: layer.source,
      },
    ] satisfies LayeredSkillCatalogEntry[]
  }

  let nestedEntries: Dirent[]
  try {
    nestedEntries = await readdir(resolve(layer.root, directoryEntry.name), {
      withFileTypes: true,
    })
  } catch (error) {
    if (shouldSkipCatalogEntryError(error)) {
      return []
    }

    throw error
  }

  const catalogEntries: LayeredSkillCatalogEntry[] = []

  for (const nestedEntry of nestedEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!nestedEntry.isDirectory() && !nestedEntry.isSymbolicLink()) {
      continue
    }

    const nestedSkillPath = `${directoryEntry.name}/${nestedEntry.name}/${SKILL_FILENAME}`
    const nestedMetadata = await maybeReadSkillMetadata(layer, nestedSkillPath, nestedEntry.name)

    if (!nestedMetadata) {
      continue
    }

    catalogEntries.push({
      ...nestedMetadata,
      path: formatLayerPath(layer, nestedSkillPath),
      source: layer.source,
    })
  }

  return catalogEntries
}

async function maybeReadSkillMetadata(layer: SkillLayer, relativeSkillPath: string, fallbackName: string) {
  try {
    const file = await resolveLayerFile(layer.root, relativeSkillPath)
    const text = (await readFile(file)).subarray(0, SKILL_METADATA_BYTES).toString("utf8")
    return parseSkillMetadata(text, fallbackName)
  } catch (error) {
    if (shouldSkipCatalogEntryError(error)) {
      return null
    }

    throw error
  }
}

async function loadLayerSkill(layer: SkillLayer, skillPath: string): Promise<LoadedSkill> {
  const relativeSkillPath = parseLayerPath(layer, skillPath)
  assertSkillEntrypointPath(relativeSkillPath, skillPath)
  const file = await resolveLayerFile(layer.root, relativeSkillPath)
  const packageDirectory = dirname(file)
  const instructions = await readFile(file, "utf8")
  const metadata = parseSkillMetadata(instructions, relativeSkillPath.split("/").at(-2) ?? relativeSkillPath)

  return {
    ...metadata,
    path: skillPath,
    entryPath: SKILL_FILENAME,
    baseDir: pathToFileURL(`${packageDirectory}${sep}`).href,
    source: layer.source,
    files: await listSupportFiles(packageDirectory),
    instructions,
  }
}

function selectEffectiveCatalogEntries(entries: LayeredSkillCatalogEntry[]) {
  const byName = new Map<string, LayeredSkillCatalogEntry & { overrides?: SkillCatalogOverride[] }>()

  for (const entry of entries) {
    const existing = byName.get(entry.name)
    if (!existing) {
      byName.set(entry.name, { ...entry })
      continue
    }

    existing.overrides = [
      ...(existing.overrides ?? []),
      {
        source: entry.source,
        path: entry.path,
      },
    ]
  }

  return [...byName.values()]
    .map((entry) => (entry.overrides?.length ? entry : withoutEmptyOverrides(entry)))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function withoutEmptyOverrides(entry: LayeredSkillCatalogEntry & { overrides?: SkillCatalogOverride[] }) {
  const { overrides: _overrides, ...catalogEntry } = entry
  return catalogEntry
}

function formatLayerPath(layer: SkillLayer, relativeSkillPath: string) {
  if (layer.pathPrefix) {
    return `${layer.pathPrefix}${relativeSkillPath}`
  }

  return `${layer.displayRoot}/${relativeSkillPath}`
}

function parseLayerPath(layer: SkillLayer, skillPath: string) {
  if (layer.pathPrefix) {
    if (!skillPath.startsWith(layer.pathPrefix)) {
      throw new Error(`Skill path must start with ${layer.pathPrefix}: ${skillPath}`)
    }

    return skillPath.slice(layer.pathPrefix.length)
  }

  const expectedPrefix = `${layer.displayRoot}/`
  if (!skillPath.startsWith(expectedPrefix)) {
    throw new Error(`Skill path must stay inside ${layer.displayRoot}: ${skillPath}`)
  }

  return skillPath.slice(expectedPrefix.length)
}

async function resolveLayerFile(root: string, relativeSkillPath: string) {
  const rootPath = await realpath(root)
  const file = await realpath(resolve(rootPath, relativeSkillPath))

  if (!isInsideDirectory(file, rootPath)) {
    throw new Error(`Skill must stay inside ${rootPath}: ${relativeSkillPath}`)
  }

  return file
}

function assertSkillEntrypointPath(relativeSkillPath: string, originalSkillPath: string) {
  const parts = relativeSkillPath.split("/")

  if (
    (parts.length === 2 || parts.length === 3) &&
    parts.every((part) => part.length > 0) &&
    parts.at(-1) === SKILL_FILENAME
  ) {
    return
  }

  throw new Error(`Skill entrypoint must be ${SKILL_FILENAME}: ${originalSkillPath}`)
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

function assertWorkspaceWritePath(skillPath: string) {
  if (skillPath.startsWith(`${SKILLS_DIRECTORY}/`)) {
    return
  }

  throw new Error(`Skill writes are limited to ${SKILLS_DIRECTORY}: ${skillPath}`)
}

function isInsideDirectory(file: string, directory: string) {
  return file === directory || file.startsWith(`${directory}${sep}`)
}

function shouldSkipCatalogEntryError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === "ENOENT"
}
