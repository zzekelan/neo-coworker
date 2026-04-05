import { join } from "node:path"
import { z } from "zod"
import { throwIfToolAborted, type ToolDefinition } from "../../domain"
import {
  listWorkspaceFiles,
  truncateWorkspaceMatches,
} from "./workspace-files"

declare const Bun: {
  Glob: new (pattern: string) => {
    match(path: string): boolean
  }
  file(path: string): {
    text(): Promise<string>
  }
}

const GrepArgsSchema = z.object({
  query: z.string().trim().min(1, "Query must not be empty").describe(
    "Text to search for across visible workspace files, such as a function name, error string, or config key. Example: `createOpenAICompatibleProvider`. When `useRegex` is true, this is treated as a JavaScript regular expression pattern.",
  ),
  useRegex: z.optional(z.boolean()).describe(
    "When true, treat `query` as a JavaScript regular expression instead of a literal substring. Invalid patterns are rejected with a user-friendly error.",
  ),
  include: z.optional(z.string().trim().min(1, "Include must not be empty")).describe(
    "Optional glob pattern that limits which relative file paths are searched, such as `src/**/*.ts` or `test/**/*.test.ts`.",
  ),
  outputMode: z.optional(z.enum(["content", "files_with_matches", "count"])).describe(
    "Controls result format. `content` returns matching lines with file and line numbers, `files_with_matches` returns one file path per matching file, and `count` returns `file: N` match counts.",
  ),
  headLimit: z.optional(z.number().int().min(1, "Head limit must be at least 1")).describe(
    "Optional maximum number of results to return. Stops scanning once that many output entries have been collected.",
  ),
}).describe(
  "Search visible workspace files for text or regex matches and return results in multiple formats. Use this to locate where a symbol, message, or snippet appears before deciding which files to read or edit. You can switch between literal and regex search, limit searched files with `include`, choose whether to return matching lines, matching file paths, or counts, and cap total results with `headLimit`. Results still respect workspace visibility rules and are truncated when many matches are returned.",
)

export function createGrepTool(): ToolDefinition {
  return {
    name: "grep",
    description:
      "Search visible workspace files for literal text or regex matches, optionally filter searched files by glob, choose line/file/count output modes, and cap total results with headLimit. Use this to locate where a symbol, message, or snippet appears before deciding which files to read or edit. Results still respect workspace visibility rules and are truncated when many matches are returned.",
    inputSchema: GrepArgsSchema,
    async execute(input) {
      const { query, useRegex, include, outputMode = "content", headLimit } = GrepArgsSchema.parse(input.args)
      const files = await listWorkspaceFiles({
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
      })
      const includeGlob = include ? new Bun.Glob(include) : null
      const searchableFiles = includeGlob
        ? files.filter((relativePath: string) => includeGlob.match(relativePath))
        : files
      const matches: string[] = []
      const matcher = createLineMatcher(query, useRegex)

      for (const relativePath of searchableFiles) {
        throwIfToolAborted(input.signal)
        const text = await Bun.file(join(input.workspaceRoot, relativePath)).text()
        const lines = text.split(/\r?\n/g)
        let fileMatchCount = 0

        for (const [index, line] of lines.entries()) {
          throwIfToolAborted(input.signal)

          if (matcher(line)) {
            fileMatchCount += 1

            if (outputMode === "content") {
              matches.push(`${relativePath}:${index + 1}: ${line.trim()}`)

              if (headLimit !== undefined && matches.length >= headLimit) {
                return { output: matches.join("\n") }
              }
            }
          }
        }

        if (fileMatchCount === 0 || outputMode === "content") {
          continue
        }

        matches.push(
          outputMode === "files_with_matches" ? relativePath : `${relativePath}: ${fileMatchCount}`,
        )

        if (headLimit !== undefined && matches.length >= headLimit) {
          return { output: matches.join("\n") }
        }
      }

      return {
        output: truncateWorkspaceMatches(matches).join("\n"),
      }
    },
  }
}

function createLineMatcher(query: string, useRegex: boolean | undefined) {
  if (!useRegex) {
    return (line: string) => line.includes(query)
  }

  let regex: RegExp

  try {
    regex = new RegExp(query)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid regex pattern: ${message}`)
  }

  return (line: string) => {
    regex.lastIndex = 0
    return regex.test(line)
  }
}
