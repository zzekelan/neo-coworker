import { realpath } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { z } from "zod"
import {
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../service"

const WriteArgsSchema = z.object({
  path: z.string().trim().min(1, "Path must not be empty"),
  content: z.string(),
})

async function resolveWorkspaceWritePath(workspaceRoot: string, relativePath: string) {
  const root = await realpath(resolve(workspaceRoot))
  const target = resolve(root, relativePath)

  try {
    const existing = await realpath(target)

    if (existing !== root && !existing.startsWith(`${root}${sep}`)) {
      throw new Error(`Path must stay inside workspace: ${relativePath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }

    const parent = await realpath(dirname(target))

    if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
      throw new Error(`Path must stay inside workspace: ${relativePath}`)
    }
  }

  return target
}

export function createWriteTool(input: { requestPermission: RequestToolPermission }): ToolDefinition {
  return {
    name: "write",
    description: "Write a UTF-8 file inside the workspace",
    inputSchema: WriteArgsSchema,
    async execute(value) {
      throwIfToolAborted(value.signal)
      const { path, content } = WriteArgsSchema.parse(value.args)
      const decision = await input.requestPermission({
        toolName: "write",
        reason: `write ${path}`,
      })

      if (decision.decision !== "allow") {
        throw new Error("Permission denied")
      }

      throwIfToolAborted(value.signal)
      const file = await resolveWorkspaceWritePath(value.workspaceRoot, path)
      throwIfToolAborted(value.signal)
      await Bun.write(file, content)

      return { output: `Wrote ${path}` }
    },
  }
}
