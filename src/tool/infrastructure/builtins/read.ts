import { realpath } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { z } from "zod"
import { throwIfToolAborted, type ToolDefinition } from "../../domain"

declare const Bun: {
  file(path: string): {
    text(): Promise<string>
  }
}

const ReadArgsSchema = z.object({
  path: z.string().describe(
    "Workspace-relative path to the UTF-8 text file to read, such as `src/tool/infrastructure/builtins/read.ts` or `docs/ARCHITECTURE.md`.",
  ),
  offset: z.optional(z.number().int().min(1, "Offset must be at least 1")).describe(
    "Optional 1-based line number to start from. When provided, the tool returns only the selected line window and prefixes each returned line as `N: content`.",
  ),
  limit: z.optional(z.number().int().min(1, "Limit must be at least 1")).describe(
    "Optional maximum number of lines to return. When used with `offset`, returns at most this many lines from that starting line; when used alone, starts from line 1.",
  ),
}).describe(
  "Read UTF-8 text contents from a file inside the workspace. Use this before editing, when you need to inspect existing code or docs, or when another tool tells you which file to open next. Prefer this over shell commands like `cat` for workspace files because it stays inside workspace guards and avoids unnecessary shell usage. The path must resolve inside the workspace and `.agents/**` runtime data is blocked. Optional `offset` and `limit` let you read only a numbered line window instead of the full file.",
)

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
      "Read UTF-8 text contents from a file inside the workspace, either as the full file or as a numbered line window with optional offset and limit. Use this before editing, when you need to inspect existing code or docs, or when another tool tells you which file to open next. Prefer this over shell commands like `cat` for workspace files because it stays inside workspace guards and avoids unnecessary shell usage. The path must resolve inside the workspace and `.agents/**` runtime data is blocked.",
    inputSchema: ReadArgsSchema,
    async execute(input) {
      throwIfToolAborted(input.signal)
      const { path, offset, limit } = ReadArgsSchema.parse(input.args)
      const file = await resolveWorkspaceFile(input.workspaceRoot, path)
      throwIfToolAborted(input.signal)
      const text = await Bun.file(file).text()

      if (offset === undefined && limit === undefined) {
        return { output: text }
      }

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
