import { type Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join, normalize, relative, resolve, sep } from "node:path"
import { z } from "zod"
import {
  isWorkspacePathReserved,
  throwIfToolAborted,
  WORKSPACE_SKIPPED_DIRECTORIES,
  type ToolDefinition,
} from "../../domain"
import { listWorkspaceFiles } from "./workspace-files"

const DEFAULT_LIMIT = 100

declare const Bun: {
  Glob: new (pattern: string) => {
    match(path: string): boolean
  }
}

const GlobArgsSchema = z.object({
  pattern: z.string().trim().min(1, "Pattern must not be empty").describe(
    'Glob pattern to match workspace files. Supports wildcards: `*` (any chars in segment), `**` (any path depth), `?` (single char), `{a,b}` (alternatives). Examples: `**/*.ts`, `src/**/index.ts`, `test/**/*.test.{ts,js}`, `**/*.{md,txt}`.',
  ),
  path: z.optional(z.string().trim().min(1, "Path must not be empty")).describe(
    "Optional workspace-relative directory to scope the search. Omit to search the whole workspace.",
  ),
  limit: z.optional(z.number().int().positive()).describe(
    `Maximum number of results to return. Defaults to ${DEFAULT_LIMIT}. Results beyond the limit are truncated with a notice.`,
  ),
}).describe(
  `Find workspace files by glob pattern and return matching paths sorted by modification time (most recently modified first). Use when you know the filename shape or extension but not the exact location, or need a quick candidate list before reading. Prefer over shell find for workspace discovery — hidden runtime state under .agents/** and unapproved .ncoworker/** paths is excluded. Pattern supports *, **, ?, and {a,b} wildcards. Optional path scopes results to a subdirectory. Results are limited to ${DEFAULT_LIMIT} by default.`,
)

export function createGlobTool(): ToolDefinition {
  return {
    name: "glob",
    description:
      `Find workspace files by glob pattern. Returns relative paths sorted by mtime (newest first). Supports *, **, ?, {a,b} wildcards. Examples: **/*.ts, src/**/index.ts, **/*.{md,txt}. Excludes .agents/** and unapproved .ncoworker/** runtime paths while allowing explicit workspace subtrees such as .ncoworker/research/**. Default limit ${DEFAULT_LIMIT} (override with limit param). Use path to scope to a subdirectory.`,
    inputSchema: GlobArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    usageGuidance: "Use glob when you need to discover files by name pattern or extension. Prefer grep for content-based discovery. Set path to narrow scope for large workspaces.",
    async execute(input) {
      const { pattern, path, limit = DEFAULT_LIMIT } = GlobArgsSchema.parse(input.args)
      const workspaceRoot = resolve(input.workspaceRoot)

      const { matches, notices } = await listWorkspaceFilesWithUnreadableDirectoryNotices({
        workspaceRoot,
        signal: input.signal,
        pattern,
      })

      const scopedMatches = path
        ? filterMatchesByPathPrefix(matches, workspaceRoot, path)
        : matches

      const sortedMatches = await sortByMtimeDesc(scopedMatches, workspaceRoot)

      if (sortedMatches.length <= limit) {
        return { output: [...sortedMatches, ...notices].join("\n") }
      }

      const truncated = [
        ...sortedMatches.slice(0, limit),
        `... truncated after ${limit} matches`,
        ...notices,
      ]
      return { output: truncated.join("\n") }
    },
  }
}

async function listWorkspaceFilesWithUnreadableDirectoryNotices(input: {
  workspaceRoot: string
  signal?: AbortSignal
  pattern: string
}): Promise<{ matches: string[]; notices: string[] }> {
  try {
    return {
      matches: await listWorkspaceFiles(input),
      notices: [],
    }
  } catch {
    return collectFilesWithUnreadableDirectoryNotices(
      input.workspaceRoot,
      input.workspaceRoot,
      new Bun.Glob(input.pattern),
      input.signal,
    )
  }
}

async function collectFilesWithUnreadableDirectoryNotices(
  workspaceRoot: string,
  directory: string,
  glob: { match(path: string): boolean },
  signal: AbortSignal | undefined,
): Promise<{ matches: string[]; notices: string[] }> {
  throwIfToolAborted(signal)

  let entries: Dirent<string>[]

  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (!isUnreadableDirectoryError(error) || directory === workspaceRoot) {
      throw error
    }

    return {
      matches: [],
      notices: [
        `Skipped unreadable directory: ${toWorkspaceRelativePath(workspaceRoot, directory)}`,
      ],
    }
  }

  const matches: string[] = []
  const notices: string[] = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfToolAborted(signal)
    const entryPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(workspaceRoot, entryPath, entry.name)) {
        continue
      }

      const nested = await collectFilesWithUnreadableDirectoryNotices(
        workspaceRoot,
        entryPath,
        glob,
        signal,
      )
      matches.push(...nested.matches)
      notices.push(...nested.notices)
      continue
    }

    if (entry.isFile()) {
      const relativePath = toWorkspaceRelativePath(workspaceRoot, entryPath)
      if (!isWorkspacePathReserved(relativePath) && glob.match(relativePath)) {
        matches.push(relativePath)
      }
    }
  }

  return { matches, notices }
}

async function sortByMtimeDesc(matches: string[], workspaceRoot: string): Promise<string[]> {
  const withMtimes = await Promise.all(
    matches.map(async (match) => {
      try {
        const info = await stat(resolve(workspaceRoot, match))
        return { match, mtime: info.mtimeMs }
      } catch {
        return { match, mtime: 0 }
      }
    }),
  )

  return withMtimes
    .sort((left, right) => right.mtime - left.mtime)
    .map((entry) => entry.match)
}

function filterMatchesByPathPrefix(matches: string[], workspaceRoot: string, inputPath: string) {
  const resolvedPath = resolve(workspaceRoot, inputPath)

  if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error(`Path must stay inside workspace: ${inputPath}`)
  }

  const relativePath = normalize(relative(workspaceRoot, resolvedPath))
  const normalizedPrefix = relativePath === "" || relativePath === "." ? "" : relativePath.replaceAll("\\", "/")

  if (normalizedPrefix === "") {
    return matches
  }

  return matches.filter(
    (match) => match === normalizedPrefix || match.startsWith(`${normalizedPrefix}/`),
  )
}

function shouldSkipDirectory(workspaceRoot: string, directory: string, name: string) {
  const relativePath = relative(workspaceRoot, directory).replaceAll("\\", "/")
  if (relativePath === ".ncoworker") {
    return false
  }

  if (isWorkspacePathReserved(relativePath)) {
    return true
  }

  return name !== ".ncoworker" && WORKSPACE_SKIPPED_DIRECTORIES.has(name)
}

function isUnreadableDirectoryError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && ((error as NodeJS.ErrnoException).code === "EACCES"
      || (error as NodeJS.ErrnoException).code === "EPERM")
  )
}

function toWorkspaceRelativePath(workspaceRoot: string, path: string) {
  return normalize(relative(workspaceRoot, path)).replaceAll("\\", "/")
}
