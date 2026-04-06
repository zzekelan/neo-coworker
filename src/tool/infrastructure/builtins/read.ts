import { readdir, realpath } from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { throwIfToolAborted, type ToolDefinition } from "../../domain"

declare const Bun: {
  file(path: string): {
    text(): Promise<string>
    size: number
  }
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".tiff", ".webp",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".bin", ".o", ".a",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac",
  ".sqlite", ".db", ".pkl", ".pyc", ".class",
])

const BLOCKED_DEVICE_PREFIXES = ["/dev/", "/proc/", "/sys/"]

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TEXT_SLICE_BYTES = 1024 * 1024

const ReadArgsSchema = z.object({
  path: z.string().describe(
    "Workspace-relative path to the file to read, e.g. `src/tool/infrastructure/builtins/read.ts` or `docs/ARCHITECTURE.md`. Must stay inside the workspace root.",
  ),
  offset: z.optional(z.number().int().min(1, "Offset must be at least 1")).describe(
    "Optional 1-based line number to start reading from. Example: `offset: 50` skips the first 49 lines. Use with `limit` to read a specific window.",
  ),
  limit: z.optional(z.number().int().min(1, "Limit must be at least 1")).describe(
    "Optional maximum number of lines to return. Example: `limit: 100` returns at most 100 lines. When used with `offset`, forms a precise line window.",
  ),
}).describe(
  "Read a UTF-8 text file from the workspace. Use this tool to inspect source code, configs, or docs before editing. Prefer this over `grep` when you need full file context, and over `glob` when you already know the exact path. Binary files (.png, .zip, .exe, etc.) are detected by extension and rejected with a descriptive message. Files over 2 MB are automatically truncated — use `offset` and `limit` to read specific line windows of large files. Each returned line is prefixed with its 1-based line number.",
)

function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

function isBlockedDevicePath(filePath: string): boolean {
  return BLOCKED_DEVICE_PREFIXES.some(prefix => filePath.startsWith(prefix))
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

async function findSimilarFiles(targetPath: string): Promise<string[]> {
  const dir = dirname(targetPath)
  const name = basename(targetPath)
  try {
    const entries = await readdir(dir)
    return entries
      .filter(entry => levenshtein(name, entry) <= 3)
      .map(entry => join(relative(process.cwd(), dir), entry))
  } catch {
    return []
  }
}

async function resolveWorkspaceFile(workspaceRoot: string, relativePath: string) {
  const root = await realpath(resolve(workspaceRoot))
  const file = await realpath(resolve(root, relativePath))

  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw new Error(`Path must stay inside workspace: ${relativePath}`)
  }

  const workspacePath = relative(root, file)
  if (workspacePath === ".agents" || workspacePath.startsWith(`.agents${sep}`)) {
    throw new Error(`Path is reserved for agent runtime data: ${relativePath}`)
  }

  return file
}

export function createReadTool(): ToolDefinition {
  return {
    name: "read",
    description:
      "Read a UTF-8 text file from the workspace. Use this tool to inspect source code, configs, or docs before editing. Prefer this over `grep` when you need full file context, and over `glob` when you already know the exact path. Binary files are detected by extension and rejected with a descriptive message. Files over 2 MB are automatically truncated — use `offset` and `limit` to read specific line windows of large files. Each returned line is prefixed with its 1-based line number.",
    inputSchema: ReadArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    resultSizeLimit: 100000,
    usageGuidance: "Use `offset` and `limit` to navigate large files. Use `grep` to search within files. Use `glob` to discover file paths.",
    async execute(input) {
      throwIfToolAborted(input.signal)
      const { path, offset, limit } = ReadArgsSchema.parse(input.args)

      if (isBlockedDevicePath(path)) {
        return {
          output: `Cannot read '${path}': device paths are blocked to prevent infinite output or blocking reads.`,
          isError: true,
        }
      }

      let file: string
      try {
        file = await resolveWorkspaceFile(input.workspaceRoot, path)
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Path must stay inside workspace")) {
          throw err
        }
        if (err instanceof Error && err.message.startsWith("Path is reserved for agent runtime data")) {
          throw err
        }
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ENOENT") {
          const absolute = resolve(input.workspaceRoot, path)
          const similar = await findSimilarFiles(absolute)
          const suggestion = similar.length > 0
            ? ` Did you mean: ${similar.join(", ")}?`
            : ""
          throw new Error(`File not found: ${path}.${suggestion}`)
        }
        throw err
      }

      if (isBinaryExtension(path)) {
        const ext = extname(path).toLowerCase()
        return {
          output: `'${path}' appears to be a binary file (${ext}). Use an appropriate tool to inspect binary files.`,
        }
      }

      throwIfToolAborted(input.signal)

      const fileInfo = Bun.file(file)
      const fileSizeBytes = fileInfo.size

      if (offset === undefined && limit === undefined) {
        if (fileSizeBytes > MAX_FILE_BYTES) {
          const text = await fileInfo.text()
          const truncated = text.slice(0, MAX_TEXT_SLICE_BYTES)
          const lines = truncated.split(/\r?\n/g)
          if (lines.at(-1) === "") lines.pop()
          const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join("\n")
          const totalLines = text.split(/\r?\n/g).length
          return {
            output: `${numbered}\n\n[Truncated: file is ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB. Showing first ${lines.length} of ~${totalLines} lines. Use offset and limit to read specific sections.]`,
          }
        }

        const text = await fileInfo.text()
        const lines = text.split(/\r?\n/g)
        if (text.endsWith("\n") && lines.at(-1) === "") {
          lines.pop()
        }
        return {
          output: lines.map((line, i) => `${i + 1}: ${line}`).join("\n"),
        }
      }

      const text = await fileInfo.text()
      const lines = text.split(/\r?\n/g)
      if (text.endsWith("\n") && lines.at(-1) === "") {
        lines.pop()
      }

      const start = (offset ?? 1) - 1
      const selectedLines = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit)
      const output = selectedLines
        .map((line, index) => `${start + index + 1}: ${line}`)
        .join("\n")

      return { output }
    },
  }
}
