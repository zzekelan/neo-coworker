import { posix as pathPosix } from "node:path"

export enum ParallelizationClass {
  NEVER_PARALLEL = "NEVER_PARALLEL",
  PARALLEL_SAFE = "PARALLEL_SAFE",
  PATH_SCOPED = "PATH_SCOPED",
}

export type ToolParallelConfig = {
  classification: ParallelizationClass
  destructivePatterns?: RegExp[]
}

export type ParallelizableToolCall = {
  name: string
  args: Record<string, unknown>
}

export const TOOL_PARALLELIZATION_DEFAULTS: Record<string, ToolParallelConfig> = {
  read: { classification: ParallelizationClass.PARALLEL_SAFE },
  glob: { classification: ParallelizationClass.PARALLEL_SAFE },
  grep: { classification: ParallelizationClass.PARALLEL_SAFE },
  get_current_datetime: { classification: ParallelizationClass.PARALLEL_SAFE },
  webfetch: { classification: ParallelizationClass.PARALLEL_SAFE },
  websearch: { classification: ParallelizationClass.PARALLEL_SAFE },
  codesearch: { classification: ParallelizationClass.PARALLEL_SAFE },
  write: { classification: ParallelizationClass.PATH_SCOPED },
  edit: { classification: ParallelizationClass.PATH_SCOPED },
  shell: { classification: ParallelizationClass.NEVER_PARALLEL },
}

type BatchState = {
  calls: ParallelizableToolCall[]
  reservedPaths: string[]
}

export function canParallelize(tools: ParallelizableToolCall[]): ParallelizableToolCall[][] {
  const batches: ParallelizableToolCall[][] = []
  let currentBatch: BatchState | null = null

  for (const tool of tools) {
    const config = TOOL_PARALLELIZATION_DEFAULTS[tool.name]

    if (config?.classification === ParallelizationClass.NEVER_PARALLEL || config === undefined) {
      flushBatch(batches, currentBatch)
      currentBatch = null
      batches.push([tool])
      continue
    }

    if (config.classification === ParallelizationClass.PATH_SCOPED) {
      const scopePath = extractScopePath(tool.args)

      if (scopePath === null) {
        flushBatch(batches, currentBatch)
        currentBatch = null
        batches.push([tool])
        continue
      }

      if (currentBatch === null) {
        currentBatch = { calls: [tool], reservedPaths: [scopePath] }
        continue
      }

      if (currentBatch.reservedPaths.some((reservedPath) => pathsOverlap(reservedPath, scopePath))) {
        flushBatch(batches, currentBatch)
        currentBatch = { calls: [tool], reservedPaths: [scopePath] }
        continue
      }

      currentBatch.calls.push(tool)
      currentBatch.reservedPaths.push(scopePath)
      continue
    }

    if (currentBatch === null) {
      currentBatch = { calls: [tool], reservedPaths: [] }
      continue
    }

    currentBatch.calls.push(tool)
  }

  flushBatch(batches, currentBatch)
  return batches
}

function flushBatch(batches: ParallelizableToolCall[][], currentBatch: BatchState | null) {
  if (currentBatch !== null && currentBatch.calls.length > 0) {
    batches.push(currentBatch.calls)
  }
}

function extractScopePath(args: Record<string, unknown>): string | null {
  const rawPath = args.path

  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return null
  }

  return normalizeScopePath(rawPath)
}

function normalizeScopePath(rawPath: string): string {
  const normalized = pathPosix.normalize(rawPath.trim().replaceAll("\\", "/"))

  if (normalized === "." || normalized === "/") {
    return normalized
  }

  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === "." || right === "." || left === "/" || right === "/") {
    return true
  }

  if (left === right) {
    return true
  }

  const leftSegments = left.split("/").filter(Boolean)
  const rightSegments = right.split("/").filter(Boolean)
  const commonLength = Math.min(leftSegments.length, rightSegments.length)

  if (commonLength === 0) {
    return false
  }

  for (let index = 0; index < commonLength; index += 1) {
    if (leftSegments[index] !== rightSegments[index]) {
      return false
    }
  }

  return true
}
