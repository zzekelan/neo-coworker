import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { getUserDataRoot } from "../../bootstrap/paths"
import { SKILL_FILENAME } from "../domain"

const BUILTIN_SKILLS_DIRECTORY_NAME = "builtin-skills"
const BUILTIN_SKILLS_MANIFEST_NAME = ".manifest.json"
const BUILTIN_SKILLS_SOURCE_ROOT = fileURLToPath(new URL("./builtins/", import.meta.url))

export type BuiltinSkillManifestFile = {
  path: string
  bytes: number
  sha256: string
}

export type BuiltinSkillManifestPackage = {
  category: string
  name: string
  entryPath: string
  files: BuiltinSkillManifestFile[]
}

export type BuiltinSkillManifest = {
  schemaVersion: 1
  generatedBy: "neo-coworker-builtin-skill-materializer"
  packages: BuiltinSkillManifestPackage[]
}

export type MaterializeBuiltinSkillsInput = {
  dataRoot?: string
  sourceRoot?: string
}

export type MaterializeBuiltinSkillsResult = {
  root: string
  manifestPath: string
  changed: boolean
  packages: BuiltinSkillManifestPackage[]
}

export function getBuiltinSkillsDirectory(dataRoot = getUserDataRoot()) {
  return join(dataRoot, BUILTIN_SKILLS_DIRECTORY_NAME)
}

export async function materializeBuiltinSkills(
  input: MaterializeBuiltinSkillsInput = {},
): Promise<MaterializeBuiltinSkillsResult> {
  const sourceRoot = resolve(input.sourceRoot ?? BUILTIN_SKILLS_SOURCE_ROOT)
  const root = getBuiltinSkillsDirectory(input.dataRoot)
  const manifestPath = join(root, BUILTIN_SKILLS_MANIFEST_NAME)
  const manifest = await buildBuiltinSkillsManifest(sourceRoot)

  if (await isMaterializedCacheCurrent(root, manifestPath, manifest)) {
    return {
      root,
      manifestPath,
      changed: false,
      packages: manifest.packages,
    }
  }

  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })

  for (const file of manifest.packages.flatMap((pkg) => pkg.files)) {
    await copySourceFile(sourceRoot, root, file.path)
  }

  await writeFile(manifestPath, renderManifest(manifest), "utf8")

  return {
    root,
    manifestPath,
    changed: true,
    packages: manifest.packages,
  }
}

async function buildBuiltinSkillsManifest(sourceRoot: string): Promise<BuiltinSkillManifest> {
  const packages: BuiltinSkillManifestPackage[] = []
  const categories = await readDirectory(sourceRoot)

  for (const categoryEntry of categories) {
    if (!categoryEntry.isDirectory()) {
      continue
    }

    const category = categoryEntry.name
    const categoryPath = join(sourceRoot, category)
    const skillEntries = await readDirectory(categoryPath)

    for (const skillEntry of skillEntries) {
      if (!skillEntry.isDirectory()) {
        continue
      }

      const name = skillEntry.name
      const packageRelativeRoot = `${category}/${name}`
      const packageRoot = join(sourceRoot, packageRelativeRoot)
      const entryPath = `${packageRelativeRoot}/${SKILL_FILENAME}`
      const files = await listPackageFiles(sourceRoot, packageRoot)

      if (!files.some((file) => file.path === entryPath)) {
        throw new Error(`Built-in skill package is missing ${SKILL_FILENAME}: ${packageRelativeRoot}`)
      }

      packages.push({
        category,
        name,
        entryPath,
        files,
      })
    }
  }

  return {
    schemaVersion: 1,
    generatedBy: "neo-coworker-builtin-skill-materializer",
    packages: packages.sort((left, right) => left.entryPath.localeCompare(right.entryPath)),
  }
}

async function listPackageFiles(sourceRoot: string, directory: string) {
  const files: BuiltinSkillManifestFile[] = []
  await collectPackageFiles(sourceRoot, directory, files)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function collectPackageFiles(
  sourceRoot: string,
  directory: string,
  files: BuiltinSkillManifestFile[],
) {
  for (const entry of await readDirectory(directory)) {
    const absolutePath = join(directory, entry.name)

    if (entry.isDirectory()) {
      await collectPackageFiles(sourceRoot, absolutePath, files)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const content = await readFile(absolutePath)
    files.push({
      path: toPortableRelativePath(sourceRoot, absolutePath),
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    })
  }
}

async function copySourceFile(sourceRoot: string, targetRoot: string, relativePath: string) {
  const sourceFile = assertInsideRoot(sourceRoot, resolve(sourceRoot, relativePath))
  const targetFile = assertInsideRoot(targetRoot, resolve(targetRoot, relativePath))

  await mkdir(dirname(targetFile), { recursive: true })
  await writeFile(targetFile, await readFile(sourceFile))
}

async function isMaterializedCacheCurrent(
  root: string,
  manifestPath: string,
  manifest: BuiltinSkillManifest,
) {
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8"))
    if (renderManifest(existing) !== renderManifest(manifest)) {
      return false
    }

    for (const file of manifest.packages.flatMap((pkg) => pkg.files)) {
      const targetFile = assertInsideRoot(root, resolve(root, file.path))
      const targetStat = await stat(targetFile)
      if (!targetStat.isFile() || targetStat.size !== file.bytes) {
        return false
      }

      const targetContent = await readFile(targetFile)
      const targetHash = createHash("sha256").update(targetContent).digest("hex")
      if (targetHash !== file.sha256) {
        return false
      }
    }

    return true
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    ) {
      return false
    }

    throw error
  }
}

async function readDirectory(path: string) {
  return (await readdir(path, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
}

function renderManifest(manifest: BuiltinSkillManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function toPortableRelativePath(root: string, path: string) {
  return assertInsideRoot(root, path).slice(resolve(root).length + 1).split(sep).join("/")
}

function assertInsideRoot(root: string, path: string) {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  const relativePath = relative(resolvedRoot, resolvedPath)

  if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes(`..${sep}`)) {
    throw new Error(`Built-in skill path must stay inside ${resolvedRoot}`)
  }

  return resolvedPath
}
