import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolCatalogEntry, ToolExecutionResult } from "../domain"
import type { ToolObserverPort } from "./ports/tool-observer"

const DEFAULT_LIMIT = 50_000
const TOOL_RESULTS_DIRECTORY = ".ncoworker/tool-results"

type ManageResultSizeOptions = {
  limit?: number
  tool?: Pick<ToolCatalogEntry, "name" | "resultSizeLimit">
  toolName?: string
  workspaceRoot?: string
  observer?: ToolObserverPort
  sessionId?: string
  runId?: string
}

export function manageResultSize(
  result: ToolExecutionResult,
  input: number | ManageResultSizeOptions = DEFAULT_LIMIT,
): ToolExecutionResult {
  if (result.isError) {
    return result
  }

  const options = typeof input === "number" ? { limit: input } : input
  const limit = options.limit ?? options.tool?.resultSizeLimit ?? DEFAULT_LIMIT
  const originalSize = Buffer.byteLength(result.output, "utf8")

  if (originalSize <= limit) {
    return result
  }

  const truncated = Buffer.from(result.output, "utf8").subarray(0, limit).toString("utf8")
  const truncatedSize = Buffer.byteLength(truncated, "utf8")
  const savedPath = persistOversizedResult({
    workspaceRoot: options.workspaceRoot,
    output: result.output,
  })

  emitTruncationEvent({
    observer: options.observer,
    sessionId: options.sessionId,
    runId: options.runId,
    toolName: options.tool?.name ?? options.toolName,
    originalSize,
    truncatedSize,
    limit,
    savedPath,
  })

  return {
    ...result,
    output: `${truncated}${buildTruncationSuffix({ originalSize, truncatedSize, savedPath })}`,
    metadata: {
      ...result.metadata,
      truncated: true,
      originalSize,
      truncatedSize,
      resultSizeLimit: limit,
      savedPath,
    },
  }
}

function buildTruncationSuffix(input: {
  originalSize: number
  truncatedSize: number
  savedPath?: string
}) {
  if (input.savedPath) {
    return `\n\n[Result truncated: ${input.originalSize}B → ${input.truncatedSize}B. Full result saved to ${input.savedPath}]`
  }

  return `\n\n[Result truncated: ${input.originalSize}B → ${input.truncatedSize}B. Full result was not persisted in this context.]`
}

function persistOversizedResult(input: {
  workspaceRoot?: string
  output: string
}): string | undefined {
  if (!input.workspaceRoot) {
    return undefined
  }

  try {
    const hash = createHash("sha256").update(input.output).digest("hex")
    const savedPath = `${TOOL_RESULTS_DIRECTORY}/${hash}.txt`
    const absoluteDirectory = join(input.workspaceRoot, TOOL_RESULTS_DIRECTORY)
    const absolutePath = join(input.workspaceRoot, savedPath)

    mkdirSync(absoluteDirectory, { recursive: true })
    writeFileSync(absolutePath, input.output, "utf8")

    return savedPath
  } catch {
    return undefined
  }
}

function emitTruncationEvent(input: {
  observer?: ToolObserverPort
  sessionId?: string
  runId?: string
  toolName?: string
  originalSize: number
  truncatedSize: number
  limit: number
  savedPath?: string
}) {
  if (!input.savedPath || !input.toolName || !input.sessionId || !input.runId) {
    return
  }

  try {
    input.observer?.recordToolEvent?.({
      type: "budget.result_truncated",
      sessionId: input.sessionId,
      runId: input.runId,
      toolName: input.toolName,
      originalSize: input.originalSize,
      truncatedSize: input.truncatedSize,
      limit: input.limit,
      savedPath: input.savedPath,
    })
  } catch {}
}
