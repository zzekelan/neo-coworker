import { stat } from "node:fs/promises"
import { basename, join } from "node:path"
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

const MAX_LINE_CHARS = 500

const GrepArgsSchema = z.object({
  pattern: z
    .string()
    .trim()
    .min(1, "Pattern must not be empty")
    .describe(
      'Regular expression pattern to search for across visible workspace files. Supports full regex syntax such as `function\\s+\\w+`, `import.*from`, or `export\\s+(async\\s+)?function`. For literal substring searches, use a plain string — regex special characters in literals must be escaped.',
    ),
  path: z
    .optional(z.string().trim().min(1))
    .describe(
      "Optional sub-path within the workspace to restrict the search scope. Example: `src/tool` to search only under that directory.",
    ),
  include: z
    .optional(z.string().trim().min(1, "Include pattern must not be empty"))
    .describe(
      'Glob pattern to filter which files are searched. Example: `"*.ts"` searches only TypeScript files, `"*.{js,jsx}"` searches JS and JSX files, `"src/**/*.ts"` restricts to TypeScript under src/.',
    ),
  output_mode: z
    .optional(z.enum(["content", "files_with_matches", "count"]))
    .describe(
      'Controls result format. `content` (default) returns matching lines with file path and line number, e.g. `src/foo.ts:12: matched text`. `files_with_matches` returns one file path per matching file — useful when you only need to know which files match. `count` returns `file: N` match counts per file.',
    ),
  head_limit: z
    .optional(z.number().int().min(0, "head_limit must be non-negative"))
    .describe(
      "Maximum number of result entries to return. When truncation occurs, a notice is appended. Pass 0 for unlimited (use sparingly — large result sets waste context). Defaults to no limit beyond workspace truncation.",
    ),
  caseSensitive: z
    .optional(z.boolean())
    .describe(
      "Whether pattern matching is case-sensitive. Defaults to true. Set to false for case-insensitive search, e.g. matching `hello`, `HELLO`, and `Hello` with the same pattern.",
    ),
  context: z
    .optional(z.number().int().min(0, "context must be non-negative"))
    .describe(
      "Number of surrounding lines to include before and after each matching line. Only applies when output_mode is `content`. Example: `context: 2` shows 2 lines before and 2 lines after each match.",
    ),
}).describe(
  "Search visible workspace files using regular expressions. Supports full regex syntax, case-insensitive matching, file-type filtering via glob, three output modes (matching lines / file paths / counts), surrounding context lines, and result pagination via head_limit. Results respect workspace visibility rules (hidden directories are excluded) and are truncated when too many matches are found. Use this to locate where a symbol, pattern, or snippet appears before deciding which files to read or edit.",
)

export function createGrepTool(): ToolDefinition {
  return {
    name: "grep",
    description:
      "Search visible workspace files for regex or literal matches. Supports full regular expression syntax (e.g. `function\\s+\\w+`), case-insensitive mode, glob file filters, three output modes (content lines / file paths / counts), surrounding context lines, and head_limit pagination. Results are sorted by recency for files_with_matches mode and are automatically truncated when many matches exist. Use this before reading or editing to locate where a symbol or pattern appears.",
    inputSchema: GrepArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    usageGuidance:
      "Prefer output_mode='files_with_matches' for broad discovery, then switch to output_mode='content' with a specific pattern to inspect matched lines. Use include to restrict to relevant file types. Use context to understand code structure around each match.",
    async execute(input) {
      const {
        pattern,
        include,
        output_mode: outputMode = "content",
        head_limit: headLimit,
        caseSensitive = true,
        context: contextLines = 0,
      } = GrepArgsSchema.parse(input.args)

      const files = await listWorkspaceFiles({
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
      })

      const includeGlob = include ? new Bun.Glob(include) : null
      const searchableFiles = includeGlob
        ? files.filter((relativePath: string) => matchesIncludeGlob(includeGlob, include!, relativePath))
        : files

      const regex = buildRegex(pattern, caseSensitive)

      if (outputMode === "files_with_matches") {
        const matchingPaths = await collectMatchingPaths(searchableFiles, input.workspaceRoot, regex, input.signal)
        const sorted = await sortByMtime(matchingPaths, input.workspaceRoot)
        const limited = applyHeadLimitToList(sorted, headLimit)
        return { output: limited.join("\n") }
      }

      if (outputMode === "count") {
        const countLines = await collectCountLines(searchableFiles, input.workspaceRoot, regex, input.signal)
        const limited = applyHeadLimitToList(countLines, headLimit)
        return { output: limited.join("\n") }
      }

      const contentLines = await collectContentLines(
        searchableFiles,
        input.workspaceRoot,
        regex,
        contextLines,
        input.signal,
      )

      if (headLimit !== undefined && headLimit > 0 && contentLines.length > headLimit) {
        const truncated = contentLines.slice(0, headLimit)
        truncated.push(`... truncated after ${headLimit} matches (${contentLines.length - headLimit} more)`)
        return { output: truncated.join("\n") }
      }

      return {
        output: truncateWorkspaceMatches(contentLines).join("\n"),
      }
    },
  }
}

function matchesIncludeGlob(glob: { match(p: string): boolean }, rawPattern: string, relativePath: string): boolean {
  if (glob.match(relativePath)) {
    return true
  }

  if (!rawPattern.includes("/")) {
    return glob.match(basename(relativePath))
  }

  return false
}

function buildRegex(pattern: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? "" : "i")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid regex pattern: ${message}`)
  }
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "..." : line
}

async function collectMatchingPaths(
  files: string[],
  workspaceRoot: string,
  regex: RegExp,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const matching: string[] = []

  for (const relativePath of files) {
    throwIfToolAborted(signal)
    const text = await Bun.file(join(workspaceRoot, relativePath)).text()
    const lines = text.split(/\r?\n/g)
    const found = lines.some((line) => {
      regex.lastIndex = 0
      return regex.test(line)
    })

    if (found) {
      matching.push(relativePath)
    }
  }

  return matching
}

async function sortByMtime(paths: string[], workspaceRoot: string): Promise<string[]> {
  const stats = await Promise.allSettled(paths.map((p) => stat(join(workspaceRoot, p))))
  return paths
    .map((p, i) => {
      const result = stats[i]
      return { path: p, mtime: result?.status === "fulfilled" ? (result.value.mtimeMs ?? 0) : 0 }
    })
    .sort((a, b) => {
      const diff = b.mtime - a.mtime
      return diff !== 0 ? diff : a.path.localeCompare(b.path)
    })
    .map((entry) => entry.path)
}

async function collectCountLines(
  files: string[],
  workspaceRoot: string,
  regex: RegExp,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const results: string[] = []

  for (const relativePath of files) {
    throwIfToolAborted(signal)
    const text = await Bun.file(join(workspaceRoot, relativePath)).text()
    const lines = text.split(/\r?\n/g)
    let count = 0

    for (const line of lines) {
      regex.lastIndex = 0
      if (regex.test(line)) {
        count += 1
      }
    }

    if (count > 0) {
      results.push(`${relativePath}: ${count}`)
    }
  }

  return results
}

async function collectContentLines(
  files: string[],
  workspaceRoot: string,
  regex: RegExp,
  contextLines: number,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const results: string[] = []

  for (const relativePath of files) {
    throwIfToolAborted(signal)
    const text = await Bun.file(join(workspaceRoot, relativePath)).text()
    const lines = text.split(/\r?\n/g)
    const matchedIndices = new Set<number>()

    for (const [index, line] of lines.entries()) {
      regex.lastIndex = 0
      if (regex.test(line)) {
        matchedIndices.add(index)
      }
    }

    if (matchedIndices.size === 0) {
      continue
    }

    const includedIndices = new Set<number>()
    for (const idx of matchedIndices) {
      for (let offset = -contextLines; offset <= contextLines; offset++) {
        const target = idx + offset
        if (target >= 0 && target < lines.length) {
          includedIndices.add(target)
        }
      }
    }

    const sortedIndices = [...includedIndices].sort((a, b) => a - b)

    for (const idx of sortedIndices) {
      const line = lines[idx] ?? ""
      results.push(`${relativePath}:${idx + 1}: ${truncateLine(line)}`)
    }
  }

  return results
}

function applyHeadLimitToList(items: string[], headLimit: number | undefined): string[] {
  if (headLimit === undefined || headLimit === 0 || items.length <= headLimit) {
    return truncateWorkspaceMatches(items)
  }

  const sliced = items.slice(0, headLimit)
  sliced.push(`... truncated after ${headLimit} entries (${items.length - headLimit} more)`)
  return sliced
}
