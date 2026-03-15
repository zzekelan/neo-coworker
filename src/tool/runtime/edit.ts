import { realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { z } from "zod"
import {
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../service"

const EditArgsSchema = z.object({
  path: z.string().trim().min(1, "Path must not be empty"),
  oldText: z.string(),
  newText: z.string(),
})

async function resolveWorkspaceFile(workspaceRoot: string, relativePath: string) {
  const root = await realpath(resolve(workspaceRoot))
  const file = await realpath(resolve(root, relativePath))

  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw new Error(`Path must stay inside workspace: ${relativePath}`)
  }

  return file
}

export function createEditTool(input: { requestPermission: RequestToolPermission }): ToolDefinition {
  return {
    name: "edit",
    description: "Replace one exact text span in a file",
    inputSchema: EditArgsSchema,
    async execute(value) {
      throwIfToolAborted(value.signal)
      const { path, oldText, newText } = EditArgsSchema.parse(value.args)
      const decision = await input.requestPermission({
        toolName: "edit",
        reason: `edit ${path}`,
      })

      if (decision.decision !== "allow") {
        throw new Error("Permission denied")
      }

      throwIfToolAborted(value.signal)
      const file = await resolveWorkspaceFile(value.workspaceRoot, path)
      const original = await Bun.file(file).text()
      throwIfToolAborted(value.signal)
      const firstMatch = original.indexOf(oldText)

      if (firstMatch === -1) {
        throw new Error("Target text not found")
      }

      const secondMatch = original.indexOf(oldText, firstMatch + 1)

      if (secondMatch !== -1) {
        throw new Error("Target text must appear exactly once")
      }

      throwIfToolAborted(value.signal)
      await Bun.write(
        file,
        `${original.slice(0, firstMatch)}${newText}${original.slice(firstMatch + oldText.length)}`,
      )

      return { output: `Edited ${path}` }
    },
  }
}
