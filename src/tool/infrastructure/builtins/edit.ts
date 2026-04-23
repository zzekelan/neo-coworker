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
import { type AtomicUtf8FileWrite, withSerializedFileMutation, writeUtf8FileAtomically } from "./mutating-file"

declare const Bun: {
  file(path: string): {
    text(): Promise<string>
  }
}

const MAX_FILE_SIZE = 500 * 1024

const EditArgsSchema = z.object({
  path: z.string().trim().min(1, "Path must not be empty").describe(
    "Workspace-relative path to the existing file you want to modify, such as `src/app/main.ts`. The file must exist and be under 500 KB.",
  ),
  oldText: z.string().describe(
    "Exact text to replace. Pass enough surrounding context to make the match unique. Without `replaceAll`, the edit fails if this text appears more than once. With `replaceAll`, every occurrence is replaced.",
  ),
  newText: z.string().describe(
    "Replacement text that will be inserted exactly where `oldText` matched. Include all desired newlines and indentation.",
  ),
  replaceAll: z.boolean().optional().describe(
    "When true, replace every occurrence of `oldText` in the file. When false (default), the edit fails if `oldText` appears more than once, protecting against unintended mass edits.",
  ),
}).describe(
  "Replace one exact text span (or all occurrences) in an existing workspace file. Use this after reading a file when you want a precise, minimal change without rewriting the whole file. This tool requires permission. Without `replaceAll`, the edit fails when `oldText` matches more than once — include enough context to avoid ambiguous replacements or set `replaceAll` to replace all occurrences. Files larger than 500 KB are rejected. On success the output includes the replacement location with surrounding context. Paths must stay inside the workspace.",
)

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

function getLineContext(lines: string[], lineIndex: number, contextSize: number): string {
  const start = Math.max(0, lineIndex - contextSize)
  const end = Math.min(lines.length - 1, lineIndex + contextSize)
  return lines
    .slice(start, end + 1)
    .map((line, i) => `L${start + i + 1}: ${line}`)
    .join("\n")
}

function getLineRangeContext(
  lines: string[],
  startLine: number,
  endLine: number,
  contextSize: number,
): string {
  const start = Math.max(0, startLine - 1 - contextSize)
  const end = Math.min(lines.length - 1, endLine - 1 + contextSize)
  return lines
    .slice(start, end + 1)
    .map((line, i) => `L${start + i + 1}: ${line}`)
    .join("\n")
}

function findMatchPositions(text: string, pattern: string): number[] {
  const positions: number[] = []
  let searchFrom = 0
  while (true) {
    const idx = text.indexOf(pattern, searchFrom)
    if (idx === -1) break
    positions.push(idx)
    searchFrom = idx + 1
  }
  return positions
}

function matchIndexToLineNumber(text: string, matchIndex: number): number {
  return text.slice(0, matchIndex).split("\n").length
}

function getSpanLineRange(text: string, startIndex: number, endIndex: number) {
  return {
    startLine: matchIndexToLineNumber(text, startIndex),
    endLine: matchIndexToLineNumber(text, endIndex),
  }
}

function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`
}

export function createEditTool(input: {
  requestPermission: RequestToolPermission
  atomicWrite?: AtomicUtf8FileWrite
}): ToolDefinition {
  const atomicWrite = input.atomicWrite ?? writeUtf8FileAtomically

  return {
    name: "edit",
    description:
      "Replace one exact text span (or all occurrences) in an existing workspace file. Use this after reading a file when you want a precise, minimal change without rewriting the whole file. This tool requires permission. Without `replaceAll`, the edit fails when `oldText` matches more than once — include enough context to avoid ambiguous replacements or set `replaceAll` to replace all occurrences. Files larger than 500 KB are rejected. On success the output includes the replacement location with surrounding context. Paths must stay inside the workspace.",
    inputSchema: EditArgsSchema,
    concurrency: "mutating",
    isCompressible: false,
    usageGuidance:
      "Read the file before editing it. Keep `oldText` unique by including enough surrounding context, or set `replaceAll: true` when every match should change. Preserve exact indentation and do not include line-number prefixes inside `oldText` or `newText`.",
    async execute(value) {
      throwIfToolAborted(value.signal)
      const { path, oldText, newText, replaceAll = false } = EditArgsSchema.parse(value.args)
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

        const original = await Bun.file(file).text()
        throwIfToolAborted(value.signal)

        const firstMatch = original.indexOf(oldText)

        if (firstMatch === -1) {
          throw new Error("Target text not found")
        }

        const matchPositions = findMatchPositions(original, oldText)
        const matchCount = matchPositions.length

        if (matchCount > 1 && !replaceAll) {
          const lines = original.split("\n")
          const contextParts = matchPositions.map((pos, i) => {
            const lineNum = matchIndexToLineNumber(original, pos)
            const ctx = getLineContext(lines, lineNum - 1, 2)
            return `Match ${i + 1} (line ${lineNum}):\n${ctx}`
          })
          return {
            output: `Found ${matchCount} matches for the target text. Use \`replaceAll: true\` to replace all occurrences, or provide more surrounding context to make the match unique.\n\n${contextParts.join("\n\n")}`,
            isError: true,
          }
        }

        throwIfToolAborted(value.signal)

        let updated: string
        let occurrences: number

        if (replaceAll) {
          let count = 0
          updated = original.replaceAll(oldText, () => {
            count++
            return newText
          })
          occurrences = count
        } else {
          updated = `${original.slice(0, firstMatch)}${newText}${original.slice(firstMatch + oldText.length)}`
          occurrences = 1
        }

        throwIfToolAborted(value.signal)
        await atomicWrite(file, updated)

        const originalLines = original.split("\n")
        const updatedLines = updated.split("\n")
        const firstBeforeRange = getSpanLineRange(original, firstMatch, firstMatch + oldText.length)
        const firstAfterRange = getSpanLineRange(updated, firstMatch, firstMatch + newText.length)
        const lastMatch = matchPositions.at(-1) ?? firstMatch
        const overallBeforeRange = getSpanLineRange(original, firstMatch, lastMatch + oldText.length)
        const beforePreview = getLineRangeContext(
          originalLines,
          firstBeforeRange.startLine,
          firstBeforeRange.endLine,
          2,
        )
        const afterPreview = getLineRangeContext(
          updatedLines,
          firstAfterRange.startLine,
          firstAfterRange.endLine,
          2,
        )
        const summary = occurrences > 1
          ? `Replaced ${occurrences} occurrences in ${path} across lines ${formatLineRange(overallBeforeRange.startLine, overallBeforeRange.endLine)}.`
          : `Edited ${path} at lines ${formatLineRange(firstBeforeRange.startLine, firstBeforeRange.endLine)}.`
        const beforeLabel = occurrences > 1 ? "First replacement preview (before):" : "Before:"
        const afterLabel = occurrences > 1 ? "First replacement preview (after):" : "After:"

        return {
          output:
            `${summary}\n` +
            `Updated lines ${formatLineRange(firstBeforeRange.startLine, firstBeforeRange.endLine)} -> ${formatLineRange(firstAfterRange.startLine, firstAfterRange.endLine)}.\n\n` +
            `${beforeLabel}\n${beforePreview}\n\n` +
            `${afterLabel}\n${afterPreview}`,
        }
      })
    },
  }
}
