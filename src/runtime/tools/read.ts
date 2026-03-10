import { realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { z } from "zod"
import { throwIfAborted, type ToolDefinition } from "./types"

const ReadArgsSchema = z.object({
  path: z.string(),
})

async function resolveWorkspaceFile(workspaceRoot: string, relativePath: string) {
  const root = await realpath(resolve(workspaceRoot))
  const file = await realpath(resolve(root, relativePath))

  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw new Error(`Path must stay inside workspace: ${relativePath}`)
  }

  return file
}

export function createReadTool(): ToolDefinition {
  return {
    name: "read",
    description: "Read a UTF-8 text file inside the workspace",
    inputSchema: ReadArgsSchema,
    async execute(input) {
      throwIfAborted(input.signal)
      const { path } = ReadArgsSchema.parse(input.args)
      const file = await resolveWorkspaceFile(input.workspaceRoot, path)
      throwIfAborted(input.signal)

      return { output: await Bun.file(file).text() }
    },
  }
}
