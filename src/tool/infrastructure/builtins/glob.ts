import { stat } from "node:fs/promises"
import { normalize, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { type ToolDefinition } from "../../domain"
import { listWorkspaceFiles } from "./workspace-files"

const DEFAULT_LIMIT = 100

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
  `Find workspace files by glob pattern and return matching paths sorted by modification time (most recently modified first). Use when you know the filename shape or extension but not the exact location, or need a quick candidate list before reading. Prefer over shell find for workspace discovery — hidden runtime state under .agents/** and .ncoworker/** is excluded. Pattern supports *, **, ?, and {a,b} wildcards. Optional path scopes results to a subdirectory. Results are limited to ${DEFAULT_LIMIT} by default.`,
)

export function createGlobTool(): ToolDefinition {
  return {
    name: "glob",
    description:
      `Find workspace files by glob pattern. Returns relative paths sorted by mtime (newest first). Supports *, **, ?, {a,b} wildcards. Examples: **/*.ts, src/**/index.ts, **/*.{md,txt}. Excludes .agents/** and .ncoworker/**. Default limit ${DEFAULT_LIMIT} (override with limit param). Use path to scope to a subdirectory.`,
    inputSchema: GlobArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    usageGuidance: "Use glob when you need to discover files by name pattern or extension. Prefer grep for content-based discovery. Set path to narrow scope for large workspaces.",
    async execute(input) {
      const { pattern, path, limit = DEFAULT_LIMIT } = GlobArgsSchema.parse(input.args)
      const workspaceRoot = resolve(input.workspaceRoot)

      const matches = await listWorkspaceFiles({
        workspaceRoot,
        signal: input.signal,
        pattern,
      })

      const scopedMatches = path
        ? filterMatchesByPathPrefix(matches, workspaceRoot, path)
        : matches

      const sortedMatches = await sortByMtimeDesc(scopedMatches, workspaceRoot)

      if (sortedMatches.length <= limit) {
        return { output: sortedMatches.join("\n") }
      }

      const truncated = [
        ...sortedMatches.slice(0, limit),
        `... truncated after ${limit} matches`,
      ]
      return { output: truncated.join("\n") }
    },
  }
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
