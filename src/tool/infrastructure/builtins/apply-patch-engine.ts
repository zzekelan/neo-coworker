import { mkdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
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
  preferEnd?: boolean
}

type ParsedPatchLine = {
  kind: "context" | "remove" | "add"
  text: string
}

type TextLine = {
  content: string
  hasLineEnding: boolean
  hasBom?: boolean
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
    let preferEnd = false

    while (index < lines.length) {
      const hunkLine = lines[index]
      if (hunkLine === "*** End Patch" || hunkLine?.startsWith("*** ") || hunkLine?.startsWith("@@")) {
        if (hunkLine === "*** End of File") {
          preferEnd = true
          index += 1
        }
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

    hunks.push({ lines: hunkLines, preferEnd })
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
  const destinationOriginalText = await readFile(destination.absolutePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }

    throw error
  })

  const originalText = await readFile(source.absolutePath, "utf8")
  const updatedText = input.operation.hunks && input.operation.hunks.length > 0
    ? applyUpdateHunks(originalText, input.operation)
    : originalText
  const hunks = input.operation.hunks ?? []
  const hunkAdditions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length,
    0,
  )
  const hunkDeletions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === "remove").length,
    0,
  )
  const destinationReplacementCounts = destinationOriginalText === null
    ? null
    : countChangedTextLines({
      originalText: destinationOriginalText,
      updatedText,
    })
  const additions = destinationReplacementCounts?.additions ?? hunkAdditions
  const deletions = destinationReplacementCounts?.deletions ?? hunkDeletions
  let diff: string
  if (destinationOriginalText !== null) {
    diff = createUnifiedDiff({
      path: destination.relativePath,
      originalText: destinationOriginalText,
      updatedText,
    })
  } else if (updatedText === originalText) {
    diff = createMoveDiff({
      from: source.relativePath,
      to: destination.relativePath,
    })
  } else {
    diff = createUnifiedDiff({
      path: destination.relativePath,
      originalText,
      updatedText,
    })
  }

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
  const { additions, deletions } = countChangedTextLines({
    originalText,
    updatedText,
  })

  return {
    path: relativePath,
    absolutePath,
    operation: "add",
    originalText,
    updatedText,
    additions,
    deletions,
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

  const root = await realpath(resolve(input.workspaceRoot))
  const candidate = resolve(root, normalizedPath)
  const relativePath = relative(root, candidate).replaceAll("\\", "/")

  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Patch path must stay inside workspace: ${input.patchPath}`)
  }

  assertWorkspacePathNotReserved(relativePath)

  if (input.mustExist) {
    const realCandidate = await realpath(candidate)
    assertRealPathInsideWorkspace(root, realCandidate, input.patchPath)
    assertWorkspacePathNotReserved(relative(root, realCandidate).replaceAll("\\", "/"))
    return {
      relativePath,
      absolutePath: realCandidate,
    }
  }

  const existingTarget = await realpath(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }

    throw error
  })

  if (existingTarget) {
    assertRealPathInsideWorkspace(root, existingTarget, input.patchPath)
    assertWorkspacePathNotReserved(relative(root, existingTarget).replaceAll("\\", "/"))
    return {
      relativePath,
      absolutePath: existingTarget,
    }
  }

  return await resolveNewPatchWorkspacePath({
    realRoot: root,
    relativePath,
    patchPath: input.patchPath,
  })
}

async function resolveNewPatchWorkspacePath(input: {
  realRoot: string
  relativePath: string
  patchPath: string
}) {
  const pathSegments = input.relativePath.split("/").filter(Boolean)
  const fileName = pathSegments.at(-1)
  if (!fileName) {
    throw new Error(`Patch path must reference a file: ${input.patchPath}`)
  }

  const parentSegments = pathSegments.slice(0, -1)
  let existingParentDir = input.realRoot
  let firstMissingIndex = parentSegments.length

  for (const [index, segment] of parentSegments.entries()) {
    const candidate = resolve(existingParentDir, segment)

    try {
      const resolvedCandidate = await realpath(candidate)
      assertRealPathInsideWorkspace(input.realRoot, resolvedCandidate, input.patchPath)
      const relativeCandidate = relative(input.realRoot, resolvedCandidate).replaceAll("\\", "/")
      if (relativeCandidate) {
        assertWorkspacePathNotReserved(relativeCandidate)
      }
      existingParentDir = resolvedCandidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }

      firstMissingIndex = index
      break
    }
  }

  for (const segment of parentSegments.slice(firstMissingIndex)) {
    existingParentDir = resolve(existingParentDir, segment)
  }

  const relativeParent = relative(input.realRoot, existingParentDir).replaceAll("\\", "/")
  if (relativeParent) {
    assertWorkspacePathNotReserved(relativeParent)
  }

  const absolutePath = resolve(existingParentDir, fileName)
  if (absolutePath === input.realRoot || absolutePath === existingParentDir || !isPathInside(existingParentDir, absolutePath)) {
    throw new Error(`Patch path must reference a file: ${input.patchPath}`)
  }

  return {
    relativePath: input.relativePath,
    absolutePath,
  }
}

function assertRealPathInsideWorkspace(realRoot: string, realPath: string, patchPath: string) {
  if (!isPathInside(realRoot, realPath)) {
    throw new Error(`Patch path must stay inside workspace: ${patchPath}`)
  }
}

function isPathInside(root: string, path: string) {
  const relativePath = relative(root, path)
  return path === root || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

function applyUpdateHunks(originalText: string, operation: ParsedPatchOperation) {
  let lines = splitTextLines(originalText)
  let searchStart = 0

  for (const hunk of operation.hunks ?? []) {
    const oldLines = hunk.lines
      .filter((line) => line.kind === "context" || line.kind === "remove")
      .map((line) => line.text)
    const matchIndex = findLineMatch(lines, oldLines, searchStart, hunk.preferEnd === true)

    if (matchIndex === -1) {
      throw new Error(`Patch context not found in ${operation.path}`)
    }

    const replacementLines = buildReplacementLines({
      hunk,
      matchedLines: lines.slice(matchIndex, matchIndex + oldLines.length),
    })

    lines = [
      ...lines.slice(0, matchIndex),
      ...replacementLines,
      ...lines.slice(matchIndex + oldLines.length),
    ]
    searchStart = matchIndex + replacementLines.length
  }

  return serializeTextLines(lines)
}

function buildReplacementLines(input: {
  hunk: ParsedPatchHunk
  matchedLines: TextLine[]
}): TextLine[] {
  let oldCursor = 0
  const replacementLines: TextLine[] = []

  for (const line of input.hunk.lines) {
    if (line.kind === "context") {
      const matchedLine = input.matchedLines[oldCursor]
      replacementLines.push({
        content: matchedLine?.content ?? line.text,
        hasLineEnding: matchedLine?.hasLineEnding ?? true,
        hasBom: matchedLine?.hasBom,
      })
      oldCursor += 1
    } else if (line.kind === "remove") {
      oldCursor += 1
    } else {
      replacementLines.push({
        content: line.text,
        hasLineEnding: true,
      })
    }
  }

  const oldLastLine = input.matchedLines.at(-1)
  if (oldLastLine && replacementLines.length > 0) {
    const lastReplacementLine = replacementLines[replacementLines.length - 1]
    if (lastReplacementLine) {
      replacementLines[replacementLines.length - 1] = {
        ...lastReplacementLine,
        hasLineEnding: oldLastLine.hasLineEnding,
      }
    }
  }

  return replacementLines
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

    const rawContent = parts[index] ?? ""
    const hasBom = index === 0 && rawContent.startsWith("\uFEFF")

    lines.push({
      content: hasBom ? rawContent.slice(1) : rawContent,
      hasLineEnding: index < parts.length - 1,
      hasBom,
    })
  }

  return lines
}

function serializeTextLines(lines: TextLine[]) {
  return lines
    .map((line, index) => `${line.hasBom ? "\uFEFF" : ""}${line.content}${index < lines.length - 1 || line.hasLineEnding ? "\n" : ""}`)
    .join("")
}

function findLineMatch(lines: TextLine[], expected: string[], searchStart: number, preferEnd: boolean) {
  if (expected.length === 0) {
    return -1
  }

  for (const normalize of [
    normalizeExact,
    normalizeTrailingWhitespace,
    normalizeTrimmed,
    normalizeUnicodeAndWhitespace,
  ]) {
    const matchIndex = preferEnd
      ? findLineMatchFromEndWithNormalizer(lines, expected, searchStart, normalize)
      : findLineMatchWithNormalizer(lines, expected, searchStart, normalize)
    if (matchIndex !== -1) {
      return matchIndex
    }
  }

  if (preferEnd) {
    for (const normalize of [
      normalizeExact,
      normalizeTrailingWhitespace,
      normalizeTrimmed,
      normalizeUnicodeAndWhitespace,
    ]) {
      const matchIndex = findLineMatchWithNormalizer(lines, expected, searchStart, normalize)
      if (matchIndex !== -1) {
        return matchIndex
      }
    }
  }

  return -1
}

function findLineMatchWithNormalizer(
  lines: TextLine[],
  expected: string[],
  searchStart: number,
  normalize: (value: string) => string,
) {
  for (let index = searchStart; index <= lines.length - expected.length; index += 1) {
    if (expected.every((line, offset) => normalize(lines[index + offset]?.content ?? "") === normalize(line))) {
      return index
    }
  }

  return -1
}

function findLineMatchFromEndWithNormalizer(
  lines: TextLine[],
  expected: string[],
  searchStart: number,
  normalize: (value: string) => string,
) {
  for (let index = lines.length - expected.length; index >= searchStart; index -= 1) {
    if (expected.every((line, offset) => normalize(lines[index + offset]?.content ?? "") === normalize(line))) {
      return index
    }
  }

  return -1
}

function normalizeExact(value: string) {
  return value
}

function normalizeTrailingWhitespace(value: string) {
  return value.trimEnd()
}

function normalizeTrimmed(value: string) {
  return value.trim()
}

function normalizeUnicodeAndWhitespace(value: string) {
  return value
    .replaceAll("\u00A0", " ")
    .replaceAll("\u2007", " ")
    .replaceAll("\u202F", " ")
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'")
    .replaceAll("\u201C", "\"")
    .replaceAll("\u201D", "\"")
    .replaceAll("\u2013", "-")
    .replaceAll("\u2014", "-")
    .trim()
}

function createUnifiedDiff(input: {
  path: string
  originalText: string
  updatedText: string
}) {
  const { removedLines, addedLines } = getChangedTextLines(input)
  const output = [
    `--- a/${input.path}`,
    `+++ b/${input.path}`,
    "@@",
    ...removedLines.map((line) => `-${line.content}`),
    ...addedLines.map((line) => `+${line.content}`),
  ]

  return output.join("\n")
}

function countChangedTextLines(input: {
  originalText: string
  updatedText: string
}) {
  const { removedLines, addedLines } = getChangedTextLines(input)
  return {
    additions: addedLines.length,
    deletions: removedLines.length,
  }
}

function getChangedTextLines(input: {
  originalText: string
  updatedText: string
}) {
  const originalLines = splitTextLines(input.originalText)
  const updatedLines = splitTextLines(input.updatedText)
  const commonPrefixLength = countCommonPrefix(originalLines, updatedLines)
  const commonSuffixLength = countCommonSuffix(
    originalLines.slice(commonPrefixLength),
    updatedLines.slice(commonPrefixLength),
  )
  const removedLines = originalLines.slice(
    commonPrefixLength,
    originalLines.length - commonSuffixLength,
  )
  const addedLines = updatedLines.slice(
    commonPrefixLength,
    updatedLines.length - commonSuffixLength,
  )

  return {
    removedLines,
    addedLines,
  }
}

function countCommonPrefix(left: TextLine[], right: TextLine[]) {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    if (!isSameDiffLine(left[index], right[index])) {
      return index
    }
  }

  return limit
}

function countCommonSuffix(left: TextLine[], right: TextLine[]) {
  const limit = Math.min(left.length, right.length)
  for (let offset = 0; offset < limit; offset += 1) {
    if (!isSameDiffLine(left[left.length - 1 - offset], right[right.length - 1 - offset])) {
      return offset
    }
  }

  return limit
}

function isSameDiffLine(left: TextLine | undefined, right: TextLine | undefined) {
  return left?.content === right?.content &&
    left?.hasBom === right?.hasBom &&
    left?.hasLineEnding === right?.hasLineEnding
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
  const originalBytes = Buffer.byteLength(diff, "utf8")
  if (originalBytes <= limit) {
    return diff
  }

  const notice = `\n[Diff preview truncated after ${limit} bytes.]`
  const noticeBytes = Buffer.byteLength(notice, "utf8")
  const bodyLimit = Math.max(0, limit - noticeBytes)
  let body = Buffer.from(diff, "utf8").subarray(0, bodyLimit).toString("utf8")
  let truncatedDiff = `${body}${notice}`

  while (Buffer.byteLength(truncatedDiff, "utf8") > limit && body.length > 0) {
    body = body.slice(0, -1)
    truncatedDiff = `${body}${notice}`
  }

  return truncatedDiff
}
