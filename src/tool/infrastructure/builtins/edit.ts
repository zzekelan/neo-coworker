import { readFile, realpath, stat } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { z } from "zod"
import {
  assertWorkspacePathNotReserved,
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import { createToolPermissionDeniedError } from "./errors"
import {
  detectEolStyle,
  formatAnchorLine,
  HashAnchorError,
  parseAnchor,
  splitLinesWithMetadata,
  validateInclusiveRange,
  type EolStyle,
} from "./hash-anchor"
import {
  type AtomicUtf8FileWrite,
  withSerializedFileMutation,
  writeUtf8FileAtomically,
} from "./mutating-file"

const MAX_FILE_SIZE = 500 * 1024
const FIRST_LINE_BOM = "\uFEFF"

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
}).strict().describe(EDIT_TOOL_DESCRIPTION)

type EditOperation = z.infer<typeof EditArgsSchema>["operation"]

type MutableLine = {
  content: string
  hasLineEnding: boolean
}

type MutationPlan = {
  updatedText: string
  previewAnchor?: string
  rangeStartLineNumber: number
  rangeEndLineNumber: number
}

type ParsedContentBlock = {
  lines: MutableLine[]
}

async function resolveWorkspaceFile(workspaceRoot: string, relativePath: string) {
  assertWorkspacePathNotReserved(relativePath)

  const root = await realpath(resolve(workspaceRoot))
  const file = await realpath(resolve(root, relativePath))

  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw new Error(`Path must stay inside workspace: ${relativePath}`)
  }

  assertWorkspacePathNotReserved(relative(root, file))

  return file
}

function resolveLineEnding(style: EolStyle, content: string): "\n" | "\r\n" {
  if (style === "crlf") {
    return "\r\n"
  }

  if (style === "lf") {
    return "\n"
  }

  return detectEolStyle(content) === "crlf" ? "\r\n" : "\n"
}

function parseContentBlock(content: string): ParsedContentBlock {
  if (content.length === 0) {
    return { lines: [] }
  }

  const lines = splitLinesWithMetadata(content)

  return {
    lines: lines.map((line, index) => ({
      content: line.rawContent,
      hasLineEnding: index < lines.length - 1 ? true : line.lineEnding !== "",
    })),
  }
}

function withTrailingLineEndingPreserved(
  lines: MutableLine[],
  shouldPreserveTrailingLineEnding: boolean,
): MutableLine[] {
  if (!shouldPreserveTrailingLineEnding || lines.length === 0 || lines.at(-1)?.hasLineEnding) {
    return lines
  }

  return [
    ...lines.slice(0, -1),
    {
      ...lines[lines.length - 1],
      hasLineEnding: true,
    },
  ]
}

function serializeLines(input: {
  lines: MutableLine[]
  lineEnding: "\n" | "\r\n"
  retainBom: boolean
}): string {
  if (input.lines.length === 0) {
    return input.retainBom ? FIRST_LINE_BOM : ""
  }

  return input.lines
    .map((line, index) => {
      const prefix = index === 0 && input.retainBom ? FIRST_LINE_BOM : ""
      const suffix = index < input.lines.length - 1 || line.hasLineEnding ? input.lineEnding : ""
      return `${prefix}${line.content}${suffix}`
    })
    .join("")
}

function toRangeDescription(startLineNumber: number, endLineNumber: number): string {
  return startLineNumber === endLineNumber
    ? `line ${startLineNumber}`
    : `lines ${startLineNumber}-${endLineNumber}`
}

function buildPreviewAnchor(updatedText: string, preferredLineNumber: number): string | undefined {
  const lines = splitLinesWithMetadata(updatedText)
  if (lines.length === 0) {
    return undefined
  }

  const lineIndex = Math.max(0, Math.min(preferredLineNumber - 1, lines.length - 1))
  const line = lines[lineIndex]
  return formatAnchorLine(line.lineNumber, line.displayContent)
}

function formatSchemaError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
      return `${path}${issue.message}`
    })
    .join("; ")
}

function buildMutationPlan(input: {
  originalText: string
  operation: EditOperation
  start: string
  end?: string
  content: string
}): MutationPlan {
  const parsedStart = parseAnchor(input.start)

  const parsedEnd = input.end ? parseAnchor(input.end) : parsedStart
  const existingLines = splitLinesWithMetadata(input.originalText)
  const range = validateInclusiveRange(existingLines, parsedStart, parsedEnd)
  const lineEnding = resolveLineEnding(detectEolStyle(input.originalText), input.content)
  const retainBom = existingLines[0]?.hasBom ?? false
  const currentLines: MutableLine[] = existingLines.map((line) => ({
    content: line.displayContent,
    hasLineEnding: line.lineEnding !== "",
  }))
  const insertedLines = withTrailingLineEndingPreserved(
    parseContentBlock(input.content).lines,
    input.operation === "replace" && existingLines[range.endLineIndex]?.lineEnding !== "",
  )

  let updatedLines: MutableLine[]
  let previewLineNumber: number

  if (input.operation === "replace") {
    updatedLines = [
      ...currentLines.slice(0, range.startLineIndex),
      ...insertedLines,
      ...currentLines.slice(range.endLineIndex + 1),
    ]
    previewLineNumber = range.startLineNumber
  } else if (input.operation === "prepend") {
    updatedLines = [
      ...currentLines.slice(0, range.startLineIndex),
      ...insertedLines,
      ...currentLines.slice(range.startLineIndex),
    ]
    previewLineNumber = range.startLineNumber
  } else {
    updatedLines = [
      ...currentLines.slice(0, range.endLineIndex + 1),
      ...insertedLines,
      ...currentLines.slice(range.endLineIndex + 1),
    ]
    previewLineNumber = insertedLines.length > 0 ? range.endLineNumber + 1 : range.endLineNumber
  }

  const updatedText = serializeLines({
    lines: updatedLines,
    lineEnding,
    retainBom,
  })

  return {
    updatedText,
    previewAnchor: buildPreviewAnchor(updatedText, previewLineNumber),
    rangeStartLineNumber: range.startLineNumber,
    rangeEndLineNumber: range.endLineNumber,
  }
}

export function createEditTool(input: {
  requestPermission: RequestToolPermission
  atomicWrite?: AtomicUtf8FileWrite
}): ToolDefinition {
  const atomicWrite = input.atomicWrite ?? writeUtf8FileAtomically

  return {
    name: "edit",
    description: EDIT_TOOL_DESCRIPTION,
    inputSchema: EditArgsSchema,
    concurrency: "mutating",
    isCompressible: false,
    usageGuidance: EDIT_TOOL_USAGE_GUIDANCE,
    async execute(value) {
      throwIfToolAborted(value.signal)
      const parsedArgs = EditArgsSchema.safeParse(value.args)
      if (!parsedArgs.success) {
        return {
          output: formatSchemaError(parsedArgs.error),
          isError: true,
        }
      }

      const { path, operation, start, end, content } = parsedArgs.data
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
        throwIfToolAborted(value.signal)
        const fileStat = await stat(file)
        if (fileStat.size > MAX_FILE_SIZE) {
          return {
            output: `File is too large to edit (${Math.round(fileStat.size / 1024)} KB). Maximum editable file size is 500 KB.`,
            isError: true,
          }
        }

        try {
          if (operation === "prepend" && end) {
            return {
              output: "`prepend` does not accept an `end` anchor.",
              isError: true,
            }
          }

          const originalText = await readFile(file, "utf8")
          throwIfToolAborted(value.signal)

          const mutation = buildMutationPlan({
            originalText,
            operation,
            start,
            end,
            content,
          })

          if (mutation.updatedText !== originalText) {
            throwIfToolAborted(value.signal)
            await atomicWrite(file, mutation.updatedText)
          }

          const previewSuffix = mutation.previewAnchor ? ` Preview: ${mutation.previewAnchor}` : ""

          return {
            output:
              `Applied ${operation} to ${path} at ${toRangeDescription(mutation.rangeStartLineNumber, mutation.rangeEndLineNumber)}.` +
              previewSuffix,
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
      })
    },
  }
}
