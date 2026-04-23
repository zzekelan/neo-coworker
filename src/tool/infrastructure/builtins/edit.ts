import { stat } from "node:fs/promises"
import { realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { z } from "zod"
import {
  assertWorkspacePathNotReserved,
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import { createToolPermissionDeniedError } from "./errors"
import { HashAnchorError, parseAnchor } from "./hash-anchor"
import { type AtomicUtf8FileWrite, withSerializedFileMutation } from "./mutating-file"

const MAX_FILE_SIZE = 500 * 1024

const EDIT_TOOL_DESCRIPTION =
  "Modify an existing workspace file using line anchors copied from read output. Read the file first, then copy the relevant anchor strings that begin with `L{line}#{hash}` into `start` and optional `end`. Use `replace` to replace the inclusive anchored range from `start` through `end` (or just `start` when `end` is omitted), `prepend` to insert `content` before the `start` anchor line, or `append` to insert `content` after `end` when `end` is provided, otherwise after `start`. This tool requires permission. Files larger than 500 KB are rejected. Paths must stay inside the workspace. Preserve inserted content exactly as written."

const EDIT_TOOL_USAGE_GUIDANCE =
  "Read the file immediately before editing. Copy the anchor string from read output and preserve the `L{line}#{hash}` prefix exactly in `start` and optional `end`. Use `end` only for a multi-line `replace` range or when `append` should insert after a later line than `start`; `prepend` should use only `start`. Preserve `content` exactly, including indentation and newlines, and do not add line numbers or anchor prefixes inside `content`."

const EditArgsSchema = z.object({
  path: z.string().trim().min(1, "Path must not be empty").describe(
    "Workspace-relative path to the existing file you want to modify, such as `src/app/main.ts`. The file must exist and be under 500 KB.",
  ),
  operation: z.enum(["replace", "prepend", "append"]).describe(
    "Edit operation to apply at the anchored location. Use `replace` to replace the inclusive span from `start` through `end` (or only `start` when `end` is omitted), `prepend` to insert `content` before the `start` anchor line, or `append` to insert `content` after `end` when `end` is provided, otherwise after `start`.",
  ),
  start: z.string().trim().min(1, "Start anchor must not be empty").describe(
    "Anchor string copied from read output for the first targeted line. Reuse the exact anchor beginning with `L{line}#{hash}` from the latest read output.",
  ),
  end: z.string().trim().min(1, "End anchor must not be empty").optional().describe(
    "Optional anchor string copied from read output for the last targeted line. Use it for a multi-line `replace` span or when `append` should insert after a later line than `start`. Do not pass `end` for `prepend`. Reuse the exact anchor beginning with `L{line}#{hash}` from the latest read output.",
  ),
  content: z.string().describe(
    "Content to insert exactly as written. Preserve indentation, spacing, and newlines exactly, and do not include read-output line numbers or anchor prefixes inside `content`.",
  ),
}).describe(EDIT_TOOL_DESCRIPTION)

async function resolveWorkspaceFile(workspaceRoot: string, relativePath: string) {
  assertWorkspacePathNotReserved(relativePath)

  const root = await realpath(resolve(workspaceRoot))
  const file = await realpath(resolve(root, relativePath))

  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw new Error(`Path must stay inside workspace: ${relativePath}`)
  }

  assertWorkspacePathNotReserved(file.slice(root.length + 1))

  return file
}

export function createEditTool(input: {
  requestPermission: RequestToolPermission
  atomicWrite?: AtomicUtf8FileWrite
}): ToolDefinition {
  return {
    name: "edit",
    description: EDIT_TOOL_DESCRIPTION,
    inputSchema: EditArgsSchema,
    concurrency: "mutating",
    isCompressible: false,
    usageGuidance: EDIT_TOOL_USAGE_GUIDANCE,
    async execute(value) {
      throwIfToolAborted(value.signal)
      const { path, operation, start, end, content } = EditArgsSchema.parse(value.args)
      assertWorkspacePathNotReserved(path)
      const decision = await input.requestPermission({
        toolName: "edit",
        reason: `edit ${path}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      throwIfToolAborted(value.signal)
      const file = await resolveWorkspaceFile(value.workspaceRoot, path)

      return await withSerializedFileMutation(file, async () => {
        const fileStat = await stat(file)
        if (fileStat.size > MAX_FILE_SIZE) {
          return {
            output: `File is too large to edit (${Math.round(fileStat.size / 1024)} KB). Maximum editable file size is 500 KB.`,
            isError: true,
          }
        }

        try {
          parseAnchor(start)
          if (end) {
            parseAnchor(end)
          }
        } catch (error) {
          if (error instanceof HashAnchorError) {
            return {
              output: error.message,
              isError: true,
            }
          }

          throw error
        }

        return {
          output:
            `Anchor-based edit execution is not implemented yet for operation \`${operation}\` on ${path}. ` +
            `The edit tool now accepts only anchor fields copied from read output (\`start\`, optional \`end\`, and exact \`content\`). ` +
            `Task 4 will add anchored mutation semantics. Received content length: ${content.length}.`,
          isError: true,
        }
      })
    },
  }
}
