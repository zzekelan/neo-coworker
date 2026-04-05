import { normalize, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { type ToolDefinition } from "../../domain"
import {
  listWorkspaceFiles,
  truncateWorkspaceMatches,
} from "./workspace-files"

const GlobArgsSchema = z.object({
  pattern: z.string().trim().min(1, "Pattern must not be empty").describe(
    "Glob pattern to match workspace files, such as `src/**/*.ts`, `test/**/*.test.ts`, or `**/*.md`.",
  ),
  path: z.optional(z.string().trim().min(1, "Path must not be empty")).describe(
    "Optional workspace-relative directory scope for the search. When provided, only matches under that directory are returned; omit it to search the whole workspace.",
  ),
}).describe(
  "Find workspace files by glob pattern and return matching relative paths. Use this when you know the filename shape or extension but not the exact location, or when you need a quick candidate list before reading files. Prefer this over shell `find` for normal workspace discovery because it stays within workspace visibility rules. Hidden runtime state under `.agents/**` is excluded and long result sets are truncated. Optional `path` lets you scope results to a subdirectory.",
)

export function createGlobTool(): ToolDefinition {
  return {
    name: "glob",
    description:
      "Find workspace files by glob pattern and return matching relative paths, with optional path scoping to a workspace subdirectory. Use this when you know the filename shape or extension but not the exact location, or when you need a quick candidate list before reading files. Prefer this over shell `find` for normal workspace discovery because it stays within workspace visibility rules. Hidden runtime state under `.agents/**` is excluded and long result sets are truncated.",
    inputSchema: GlobArgsSchema,
    async execute(input) {
      const { pattern, path } = GlobArgsSchema.parse(input.args)
      const matches = await listWorkspaceFiles({
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
        pattern,
      })
      const scopedMatches = path ? filterMatchesByPathPrefix(matches, input.workspaceRoot, path) : matches

      return {
        output: truncateWorkspaceMatches(scopedMatches).join("\n"),
      }
    },
  }
}

function filterMatchesByPathPrefix(matches: string[], workspaceRoot: string, inputPath: string) {
  const workspace = resolve(workspaceRoot)
  const resolvedPath = resolve(workspace, inputPath)

  if (resolvedPath !== workspace && !resolvedPath.startsWith(`${workspace}${sep}`)) {
    throw new Error(`Path must stay inside workspace: ${inputPath}`)
  }

  const relativePath = normalize(relative(workspace, resolvedPath))
  const normalizedPrefix = relativePath === "" || relativePath === "." ? "" : relativePath.replaceAll("\\", "/")

  if (normalizedPrefix === "") {
    return matches
  }

  return matches.filter(
    (match) => match === normalizedPrefix || match.startsWith(`${normalizedPrefix}/`),
  )
}
