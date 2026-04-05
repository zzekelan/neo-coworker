import { realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { z } from "zod"
import {
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import { createToolPermissionDeniedError } from "./errors"

declare const Bun: {
  file(path: string): {
    text(): Promise<string>
  }
  write(path: string, content: string): Promise<unknown>
}

const EditArgsSchema = z.object({
  path: z.string().trim().min(1, "Path must not be empty").describe(
    "Workspace-relative path to the existing file you want to modify, such as `src/app/main.ts`.",
  ),
  oldText: z.string().describe(
    "Exact text to replace. Pass enough surrounding context to make the match unique; the edit fails if this text is missing or appears more than once.",
  ),
  newText: z.string().describe(
    "Replacement text that will be inserted exactly where `oldText` matched. Include all desired newlines and indentation.",
  ),
}).describe(
  "Replace one exact text span in an existing workspace file. Use this after reading a file when you want a precise, minimal change without rewriting the whole file. This tool requires permission and only succeeds when `oldText` matches exactly once, so include enough context to avoid ambiguous replacements. Paths must stay inside the workspace.",
)

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
    description:
      "Replace one exact text span in an existing workspace file. Use this after reading a file when you want a precise, minimal change without rewriting the whole file. This tool requires permission and only succeeds when `oldText` matches exactly once, so include enough context to avoid ambiguous replacements. Paths must stay inside the workspace.",
    inputSchema: EditArgsSchema,
    async execute(value) {
      throwIfToolAborted(value.signal)
      const { path, oldText, newText } = EditArgsSchema.parse(value.args)
      const decision = await input.requestPermission({
        toolName: "edit",
        reason: `edit ${path}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
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
