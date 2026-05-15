import { mkdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  assertWorkspacePathNotReserved,
} from "../../domain"
import {
  type AtomicUtf8FileWrite,
  writeUtf8FileAtomically,
} from "./mutating-file"

export type PatchFileOperation = "add" | "delete" | "move" | "update"

export type PatchFileSummary = {
  path: string
  operation: PatchFileOperation
  additions: number
  deletions: number
}

export type PatchPlan = {
  changes: PatchFileChange[]
  summaries: PatchFileSummary[]
  totalAdditions: number
  totalDeletions: number
  diff: string
}

export type PatchFileChange = {
  path: string
  absolutePath: string
  operation: PatchFileOperation
  previousPath?: string
  previousAbsolutePath?: string
  originalText: string
  updatedText: string
  additions: number
  deletions: number
  diff: string
}

type ParsedPatch = {
  operations: ParsedPatchOperation[]
}

type ParsedPatchOperation = {
  operation: PatchFileOperation
  path: string
  moveTo?: string
  hunks?: ParsedPatchHunk[]
  addedLines?: string[]
}

type ParsedPatchHunk = {
  lines: ParsedPatchLine[]
}

type ParsedPatchLine = {
  kind: "context" | "remove" | "add"
  text: string
}

type TextLine = {
  content: string
  hasLineEnding: boolean
}

export const APPLY_PATCH_RESULT_DIFF_LIMIT = 16 * 1024

export async function planApplyPatch(input: {
  workspaceRoot: string
  patchText: string
}): Promise<PatchPlan> {
  const parsed = parsePatchText(input.patchText)
  const changes: PatchFileChange[] = []

  for (const operation of parsed.operations) {
    if (operation.operation === "add") {
      changes.push(await planAddFile({
        workspaceRoot: input.workspaceRoot,
        operation,
      }))
    } else if (operation.operation === "delete") {
      changes.push(await planDeleteFile({
        workspaceRoot: input.workspaceRoot,
        operation,
      }))
    } else if (operation.operation === "move") {
      changes.push(await planMoveFile({
        workspaceRoot: input.workspaceRoot,
        operation,
      }))
    } else if (operation.operation === "update") {
      changes.push(await planUpdateFile({
        workspaceRoot: input.workspaceRoot,
        operation,
      }))
    }
  }

  if (changes.length === 0) {
    throw new Error("Patch must contain at least one file change")
  }

  const totalAdditions = changes.reduce((total, change) => total + change.additions, 0)
  const totalDeletions = changes.reduce((total, change) => total + change.deletions, 0)

  return {
    changes,
    summaries: changes.map((change) => ({
      path: change.path,
      operation: change.operation,
      additions: change.additions,
      deletions: change.deletions,
    })),
    totalAdditions,
    totalDeletions,
    diff: changes.map((change) => change.diff).join("\n"),
  }
}

export async function applyPatchPlan(
  plan: PatchPlan,
  input: {
    atomicWrite?: AtomicUtf8FileWrite
  } = {},
) {
  const atomicWrite = input.atomicWrite ?? writeUtf8FileAtomically

  for (const change of plan.changes) {
    if (change.operation === "delete") {
      await unlink(change.absolutePath)
    } else if (change.operation === "move" && change.previousAbsolutePath) {
      await mkdir(dirname(change.absolutePath), { recursive: true })
      if (change.updatedText === change.originalText) {
        await rename(change.previousAbsolutePath, change.absolutePath)
      } else {
        await atomicWrite(change.absolutePath, change.updatedText)
        await unlink(change.previousAbsolutePath)
      }
    } else if (change.updatedText !== change.originalText) {
      await mkdir(dirname(change.absolutePath), { recursive: true })
      await atomicWrite(change.absolutePath, change.updatedText)
    }
  }
}

export function formatPatchToolResult(plan: PatchPlan) {
  const plural = plan.changes.length === 1 ? "file" : "files"
  const summary = `Applied patch to ${plan.changes.length} ${plural}: ${plan.summaries
    .map((change) => `${change.path} (${change.operation}, +${change.additions}/-${change.deletions})`)
    .join(", ")}.`
  const diff = truncateDiffPreview(plan.diff, APPLY_PATCH_RESULT_DIFF_LIMIT)

  return `${summary}\n\n${diff}`
}

function parsePatchText(patchText: string): ParsedPatch {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n")
  let index = 0

  while (lines[index]?.trim() === "") {
    index += 1
  }

  if (lines[index] !== "*** Begin Patch") {
    throw new Error("Patch must start with *** Begin Patch")
  }
  index += 1

  const operations: ParsedPatchOperation[] = []

  while (index < lines.length) {
    const line = lines[index]
    if (line === "*** End Patch") {
      index += 1
      break
    }

    if (line?.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim()
      const { operation, nextIndex } = parseUpdateOperation(lines, index + 1, path)
      operations.push(operation)
      index = nextIndex
      continue
    }

    if (line?.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim()
      const { operation, nextIndex } = parseAddOperation(lines, index + 1, path)
      operations.push(operation)
      index = nextIndex
      continue
    }

    if (line?.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim()
      operations.push(parseDeleteOperation(path))
      index += 1
      continue
    }

    if (line?.trim() === "") {
      index += 1
      continue
    }

    throw new Error(`Unsupported patch line: ${line}`)
  }

  while (lines[index]?.trim() === "") {
    index += 1
  }

  if (index < lines.length) {
    throw new Error(`Unexpected content after patch end: ${lines[index]}`)
  }

  if (operations.length === 0) {
    throw new Error("Patch must contain at least one file change")
  }

  return { operations }
}

function parseAddOperation(lines: string[], startIndex: number, path: string) {
  if (!path) {
    throw new Error("Add File path must not be empty")
  }

  let index = startIndex
  const addedLines: string[] = []

  while (index < lines.length) {
    const line = lines[index]
    if (line === "*** End Patch" || line?.startsWith("*** ")) {
      break
    }

    if (!line?.startsWith("+")) {
      throw new Error(`Add File ${path} lines must start with +`)
    }

    addedLines.push(line.slice(1))
    index += 1
  }

  if (addedLines.length === 0) {
    throw new Error(`Add File ${path} must contain at least one line`)
  }

  return {
    operation: {
      operation: "add" as const,
      path,
      addedLines,
    },
    nextIndex: index,
  }
}

function parseUpdateOperation(lines: string[], startIndex: number, path: string) {
  if (!path) {
    throw new Error("Update File path must not be empty")
  }

  let index = startIndex
  const hunks: ParsedPatchHunk[] = []
  let moveTo: string | undefined

  while (index < lines.length) {
    const line = lines[index]
    if (line === "*** End Patch" || line?.startsWith("*** ")) {
      if (line?.startsWith("*** Move to: ")) {
        moveTo = line.slice("*** Move to: ".length).trim()
        if (!moveTo) {
          throw new Error("Move to path must not be empty")
        }
        index += 1
        continue
      }

      break
    }

    if (!line?.startsWith("@@")) {
      throw new Error(`Update File ${path} must contain hunk markers`)
    }

    index += 1
    const hunkLines: ParsedPatchLine[] = []

    while (index < lines.length) {
      const hunkLine = lines[index]
      if (hunkLine === "*** End Patch" || hunkLine?.startsWith("*** ") || hunkLine?.startsWith("@@")) {
        break
      }

      if (hunkLine?.startsWith(" ")) {
        hunkLines.push({ kind: "context", text: hunkLine.slice(1) })
      } else if (hunkLine?.startsWith("-")) {
        hunkLines.push({ kind: "remove", text: hunkLine.slice(1) })
      } else if (hunkLine?.startsWith("+")) {
        hunkLines.push({ kind: "add", text: hunkLine.slice(1) })
      } else {
        throw new Error(`Invalid hunk line in ${path}: ${hunkLine}`)
      }

      index += 1
    }

    if (!hunkLines.some((line) => line.kind === "add" || line.kind === "remove")) {
      throw new Error(`Update File ${path} hunk must add or remove at least one line`)
    }

    hunks.push({ lines: hunkLines })
  }

  if (hunks.length === 0 && !moveTo) {
    throw new Error(`Update File ${path} must contain at least one hunk`)
  }

  return {
    operation: {
      operation: moveTo ? "move" as const : "update" as const,
      path,
      moveTo,
      hunks,
    },
    nextIndex: index,
  }
}

function parseDeleteOperation(path: string): ParsedPatchOperation {
  if (!path) {
    throw new Error("Delete File path must not be empty")
  }

  return {
    operation: "delete",
    path,
  }
}

async function planUpdateFile(input: {
  workspaceRoot: string
  operation: ParsedPatchOperation
}): Promise<PatchFileChange> {
  const { relativePath, absolutePath } = await resolvePatchWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    patchPath: input.operation.path,
    mustExist: true,
  })
  const originalText = await readFile(absolutePath, "utf8")
  const updatedText = applyUpdateHunks(originalText, input.operation)
  const hunks = input.operation.hunks ?? []
  const additions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length,
    0,
  )
  const deletions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "remove").length,
    0,
  )

  if (updatedText === originalText) {
    throw new Error(`Patch does not change ${relativePath}`)
  }

  const diff = createUnifiedDiff({
    path: relativePath,
    originalText,
    updatedText,
  })

  return {
    path: relativePath,
    absolutePath,
    operation: "update",
    originalText,
    updatedText,
    additions,
    deletions,
    diff,
  }
}

async function planMoveFile(input: {
  workspaceRoot: string
  operation: ParsedPatchOperation
}): Promise<PatchFileChange> {
  const moveTo = input.operation.moveTo
  if (!moveTo) {
    throw new Error(`Move operation for ${input.operation.path} is missing destination`)
  }

  const source = await resolvePatchWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    patchPath: input.operation.path,
    mustExist: true,
  })
  const destination = await resolvePatchWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    patchPath: moveTo,
    mustExist: false,
  })
  const sourceStat = await stat(source.absolutePath)
  if (!sourceStat.isFile()) {
    throw new Error(`Move source must be a file, not a directory: ${source.relativePath}`)
  }

  await stat(destination.absolutePath).then((destinationStat) => {
    if (destinationStat.isDirectory()) {
      throw new Error(`Move destination must not be a directory: ${destination.relativePath}`)
    }
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  })

  const originalText = await readFile(source.absolutePath, "utf8")
  const updatedText = input.operation.hunks && input.operation.hunks.length > 0
    ? applyUpdateHunks(originalText, input.operation)
    : originalText
  const hunks = input.operation.hunks ?? []
  const additions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length,
    0,
  )
  const deletions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "remove").length,
    0,
  )
  const diff = updatedText === originalText
    ? createMoveDiff({
      from: source.relativePath,
      to: destination.relativePath,
    })
    : createUnifiedDiff({
      path: destination.relativePath,
      originalText,
      updatedText,
    })

  return {
    path: destination.relativePath,
    absolutePath: destination.absolutePath,
    operation: "move",
    previousPath: source.relativePath,
    previousAbsolutePath: source.absolutePath,
    originalText,
    updatedText,
    additions,
    deletions,
    diff,
  }
}

async function planDeleteFile(input: {
  workspaceRoot: string
  operation: ParsedPatchOperation
}): Promise<PatchFileChange> {
  const { relativePath, absolutePath } = await resolvePatchWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    patchPath: input.operation.path,
    mustExist: true,
  })
  const fileStat = await stat(absolutePath)
  if (!fileStat.isFile()) {
    throw new Error(`Delete File target must be a file, not a directory: ${relativePath}`)
  }

  const originalText = await readFile(absolutePath, "utf8")
  const diff = createUnifiedDiff({
    path: relativePath,
    originalText,
    updatedText: "",
  })

  return {
    path: relativePath,
    absolutePath,
    operation: "delete",
    originalText,
    updatedText: "",
    additions: 0,
    deletions: splitTextLines(originalText).length,
    diff,
  }
}

async function planAddFile(input: {
  workspaceRoot: string
  operation: ParsedPatchOperation
}): Promise<PatchFileChange> {
  const { relativePath, absolutePath } = await resolvePatchWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    patchPath: input.operation.path,
    mustExist: false,
  })
  const addedLines = input.operation.addedLines ?? []
  const updatedText = `${addedLines.join("\n")}\n`
  const originalText = await readFile(absolutePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ""
    }

    throw error
  })
  const diff = createUnifiedDiff({
    path: relativePath,
    originalText,
    updatedText,
  })

  return {
    path: relativePath,
    absolutePath,
    operation: "add",
    originalText,
    updatedText,
    additions: addedLines.length,
    deletions: 0,
    diff,
  }
}

async function resolvePatchWorkspacePath(input: {
  workspaceRoot: string
  patchPath: string
  mustExist: boolean
}) {
  const normalizedPath = input.patchPath.replaceAll("\\", "/")
  if (isAbsolute(normalizedPath) || normalizedPath.startsWith("/") || normalizedPath.trim() === "") {
    throw new Error(`Patch paths must be workspace-relative: ${input.patchPath}`)
  }

  const root = resolve(input.workspaceRoot)
  const candidate = resolve(root, normalizedPath)
  const relativePath = relative(root, candidate).replaceAll("\\", "/")

  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Patch path must stay inside workspace: ${input.patchPath}`)
  }

  assertWorkspacePathNotReserved(relativePath)

  if (input.mustExist) {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ])

    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`Patch path must stay inside workspace: ${input.patchPath}`)
    }

    assertWorkspacePathNotReserved(relative(realRoot, realCandidate).replaceAll("\\", "/"))
  }

  return {
    relativePath,
    absolutePath: candidate,
  }
}

function applyUpdateHunks(originalText: string, operation: ParsedPatchOperation) {
  let lines = splitTextLines(originalText)
  let searchStart = 0

  for (const hunk of operation.hunks ?? []) {
    const oldLines = hunk.lines
      .filter((line) => line.kind === "context" || line.kind === "remove")
      .map((line) => line.text)
    const newLines = hunk.lines
      .filter((line) => line.kind === "context" || line.kind === "add")
      .map((line) => line.text)
    const matchIndex = findExactLineMatch(lines, oldLines, searchStart)

    if (matchIndex === -1) {
      throw new Error(`Patch context not found in ${operation.path}`)
    }

    const replacementLines = newLines.map((content, index) => ({
      content,
      hasLineEnding: index < newLines.length - 1 || lines[matchIndex + oldLines.length - 1]?.hasLineEnding === true,
    }))

    lines = [
      ...lines.slice(0, matchIndex),
      ...replacementLines,
      ...lines.slice(matchIndex + oldLines.length),
    ]
    searchStart = matchIndex + replacementLines.length
  }

  return serializeTextLines(lines)
}

function splitTextLines(text: string): TextLine[] {
  if (text.length === 0) {
    return []
  }

  const normalizedText = text.replace(/\r\n/g, "\n")
  const parts = normalizedText.split("\n")
  const lines: TextLine[] = []

  for (let index = 0; index < parts.length; index += 1) {
    if (index === parts.length - 1 && parts[index] === "") {
      continue
    }

    lines.push({
      content: parts[index] ?? "",
      hasLineEnding: index < parts.length - 1,
    })
  }

  return lines
}

function serializeTextLines(lines: TextLine[]) {
  return lines
    .map((line, index) => `${line.content}${index < lines.length - 1 || line.hasLineEnding ? "\n" : ""}`)
    .join("")
}

function findExactLineMatch(lines: TextLine[], expected: string[], searchStart: number) {
  if (expected.length === 0) {
    return -1
  }

  for (let index = searchStart; index <= lines.length - expected.length; index += 1) {
    if (expected.every((line, offset) => lines[index + offset]?.content === line)) {
      return index
    }
  }

  return -1
}

function createUnifiedDiff(input: {
  path: string
  originalText: string
  updatedText: string
}) {
  const originalLines = splitTextLines(input.originalText)
  const updatedLines = splitTextLines(input.updatedText)
  const output = [
    `--- a/${input.path}`,
    `+++ b/${input.path}`,
    "@@",
    ...originalLines.map((line) => `-${line.content}`),
    ...updatedLines.map((line) => `+${line.content}`),
  ]

  return output.join("\n")
}

function createMoveDiff(input: {
  from: string
  to: string
}) {
  return [
    `rename from ${input.from}`,
    `rename to ${input.to}`,
  ].join("\n")
}

function truncateDiffPreview(diff: string, limit: number) {
  if (diff.length <= limit) {
    return diff
  }

  return `${diff.slice(0, limit)}\n[Diff preview truncated after ${limit} bytes.]`
}
