import { realpath } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { z } from "zod"
import type { PermissionCoordinator } from "../permissions"
import { throwIfAborted, type ToolDefinition } from "./types"

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

export function createWriteTool({
  permissions,
}: {
  permissions: PermissionCoordinator
}): ToolDefinition {
  return {
    name: "write",
    description: "Write a UTF-8 file inside the workspace",
    inputSchema: WriteArgsSchema,
    async execute(input) {
      throwIfAborted(input.signal)
      const { path, content } = WriteArgsSchema.parse(input.args)
      const decision = await permissions.request({
        toolName: "write",
        reason: `write ${path}`,
      })

      if (decision.decision !== "allow") {
        throw new Error("Permission denied")
      }

      throwIfAborted(input.signal)
      const file = await resolveWorkspaceWritePath(input.workspaceRoot, path)

      throwIfAborted(input.signal)
      await Bun.write(file, content)

      return { output: `Wrote ${path}` }
    },
  }
}
