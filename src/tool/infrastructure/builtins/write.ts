import { realpath } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { z } from "zod"
import {
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import { createToolPermissionDeniedError } from "./errors"

declare const Bun: {
  write(path: string, content: string): Promise<unknown>
}

const WriteArgsSchema = z.object({
  path: z.string().trim().min(1, "Path must not be empty").describe(
    "Workspace-relative file path to create or overwrite, for example `notes/todo.md` or `src/example.ts`. Parent directories must already resolve inside the workspace.",
  ),
  content: z.string().describe(
    "Complete UTF-8 file contents to write. Pass the full desired file body, not a patch or partial replacement.",
  ),
}).describe(
  "Create or overwrite a UTF-8 file inside the workspace. Use this when you need to write a full file from scratch or replace the entire contents in one step; prefer `edit` when you only need to change one exact span in an existing file. This tool requires permission because it mutates workspace state. Paths must stay inside the workspace.",
)

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
    description:
      "Create or overwrite a UTF-8 file inside the workspace. Use this when you need to write a full file from scratch or replace the entire contents in one step; prefer `edit` when you only need to change one exact span in an existing file. This tool requires permission because it mutates workspace state. Paths must stay inside the workspace.",
    inputSchema: WriteArgsSchema,
    concurrency: "mutating",
    isCompressible: false,
    async execute(value) {
      throwIfToolAborted(value.signal)
      const { path, content } = WriteArgsSchema.parse(value.args)
      const decision = await input.requestPermission({
        toolName: "write",
        reason: `write ${path}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      throwIfToolAborted(value.signal)
      const file = await resolveWorkspaceWritePath(value.workspaceRoot, path)
      throwIfToolAborted(value.signal)
      await Bun.write(file, content)

      return { output: `Wrote ${path}` }
    },
  }
}
