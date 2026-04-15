import { posix as pathPosix } from "node:path"
import {
  canParallelize,
  ParallelizationClass,
  shouldCheckpoint,
  TOOL_PARALLELIZATION_DEFAULTS,
  type ParallelizableToolCall,
  type ToolParallelConfig,
} from "../domain"
import type { ToolObserverEvent, ToolObserverPort } from "./ports/tool-observer"

export const MAX_PARALLEL_BATCH_SIZE = 8

const NEVER_PARALLEL_SURROGATE = "shell"
const PARALLEL_SAFE_SURROGATE = "read"
const PATH_SCOPED_SURROGATE = "write"

type ParallelToolObserverEvent = Extract<
  ToolObserverEvent,
  {
    type:
      | "parallel.plan_generated"
      | "parallel.batch_started"
      | "parallel.batch_completed"
      | "parallel.conflict_detected"
  }
>

type ParallelToolObserverEventInput =
  | Omit<Extract<ParallelToolObserverEvent, { type: "parallel.plan_generated" }>, "sessionId" | "runId">
  | Omit<Extract<ParallelToolObserverEvent, { type: "parallel.batch_started" }>, "sessionId" | "runId">
  | Omit<Extract<ParallelToolObserverEvent, { type: "parallel.batch_completed" }>, "sessionId" | "runId">
  | Omit<Extract<ParallelToolObserverEvent, { type: "parallel.conflict_detected" }>, "sessionId" | "runId">

type PreparedToolCall = {
  original: ParallelExecutorToolCall
  effectiveConfig?: ToolParallelConfig
  scopePath: string | null
}

type ReservedPath = {
  toolName: string
  scopePath: string
}

export type ParallelExecutorToolCall = ParallelizableToolCall

export type ParallelExecutorBatchRunner<T> = (
  batch: ParallelExecutorToolCall[],
  batchIndex: number,
) => Promise<T> | T

export type ParallelExecutorOptions = {
  observer?: ToolObserverPort
  observerContext?: {
    sessionId: string
    runId: string
  }
  now?: () => number
}

export class ParallelExecutor {
  private readonly config: Map<string, ToolParallelConfig>

  private readonly observer?: ToolObserverPort

  private readonly observerContext?: {
    sessionId: string
    runId: string
  }

  private readonly now: () => number

  constructor(
    config: Map<string, ToolParallelConfig> = new Map(),
    options: ParallelExecutorOptions = {},
  ) {
    this.config = new Map(config)
    this.observer = options.observer
    this.observerContext = options.observerContext
    this.now = options.now ?? Date.now
  }

  planExecution(calls: ParallelExecutorToolCall[]): ParallelExecutorToolCall[][] {
    const preparedCalls = calls.map((call) => prepareToolCall(call, this.resolveToolConfig(call)))

    for (const conflict of detectPathConflicts(preparedCalls)) {
      this.emitObserverEvent({
        type: "parallel.conflict_detected",
        payload: conflict,
      })
    }

    const batches = applyBatchLimit(buildExecutionPlan(preparedCalls), MAX_PARALLEL_BATCH_SIZE)

    this.emitObserverEvent({
      type: "parallel.plan_generated",
      payload: {
        totalCalls: calls.length,
        batchCount: batches.length,
        maxBatchSize: batches.reduce(
          (currentMax, batch) => Math.max(currentMax, batch.length),
          0,
        ),
      },
    })

    return batches
  }

  async schedule<T>(
    calls: ParallelExecutorToolCall[],
    runBatch: ParallelExecutorBatchRunner<T>,
  ): Promise<T[]> {
    const batches = this.planExecution(calls)
    const results: T[] = []

    for (const [batchIndex, batch] of batches.entries()) {
      const startedAt = this.now()
      this.emitObserverEvent({
        type: "parallel.batch_started",
        payload: {
          batchIndex,
          callCount: batch.length,
          toolNames: batch.map((call) => call.name),
        },
      })

      try {
        results.push(await runBatch(batch, batchIndex))
      } finally {
        this.emitObserverEvent({
          type: "parallel.batch_completed",
          payload: {
            batchIndex,
            durationMs: Math.max(0, this.now() - startedAt),
          },
        })
      }
    }

    return results
  }

  private resolveToolConfig(call: ParallelExecutorToolCall): ToolParallelConfig | undefined {
    const configured = this.config.get(call.name) ?? TOOL_PARALLELIZATION_DEFAULTS[call.name]

    if (!configured) {
      return undefined
    }

    if (call.name !== "shell" || configured.classification === ParallelizationClass.NEVER_PARALLEL) {
      return configured
    }

    return isDestructiveShellCall(call.args, configured)
      ? {
          ...configured,
          classification: ParallelizationClass.NEVER_PARALLEL,
        }
      : configured
  }

  private emitObserverEvent(event: ParallelToolObserverEventInput) {
    if (!this.observerContext) {
      return
    }

    try {
      this.observer?.recordToolEvent?.({
        ...event,
        sessionId: this.observerContext.sessionId,
        runId: this.observerContext.runId,
      })
    } catch {}
  }
}

function buildExecutionPlan(preparedCalls: PreparedToolCall[]): ParallelExecutorToolCall[][] {
  const transformedToOriginal = new Map<ParallelizableToolCall, ParallelExecutorToolCall>()
  const transformedCalls = preparedCalls.map((call) => {
    const transformedCall: ParallelizableToolCall = {
      name: resolveSurrogateToolName(call),
      args: call.original.args,
    }
    transformedToOriginal.set(transformedCall, call.original)
    return transformedCall
  })

  return canParallelize(transformedCalls).map((batch) =>
    batch.map((call) => {
      const originalCall = transformedToOriginal.get(call)
      if (!originalCall) {
        throw new Error(`Missing original tool call for transformed call ${call.name}`)
      }

      return originalCall
    }),
  )
}

function resolveSurrogateToolName(call: PreparedToolCall): string {
  switch (call.effectiveConfig?.classification) {
    case ParallelizationClass.NEVER_PARALLEL:
      return NEVER_PARALLEL_SURROGATE
    case ParallelizationClass.PARALLEL_SAFE:
      return PARALLEL_SAFE_SURROGATE
    case ParallelizationClass.PATH_SCOPED:
      return PATH_SCOPED_SURROGATE
    default:
      return call.original.name
  }
}

function prepareToolCall(
  call: ParallelExecutorToolCall,
  config?: ToolParallelConfig,
): PreparedToolCall {
  return {
    original: call,
    effectiveConfig: config,
    scopePath:
      config?.classification === ParallelizationClass.PATH_SCOPED
        ? extractScopePath(call.args)
        : null,
  }
}

function applyBatchLimit(
  batches: ParallelExecutorToolCall[][],
  maxBatchSize: number,
): ParallelExecutorToolCall[][] {
  return batches.flatMap((batch) => chunkBatch(batch, maxBatchSize))
}

function chunkBatch(
  batch: ParallelExecutorToolCall[],
  maxBatchSize: number,
): ParallelExecutorToolCall[][] {
  if (batch.length <= maxBatchSize) {
    return [batch]
  }

  const chunks: ParallelExecutorToolCall[][] = []
  for (let index = 0; index < batch.length; index += maxBatchSize) {
    chunks.push(batch.slice(index, index + maxBatchSize))
  }

  return chunks
}

function detectPathConflicts(preparedCalls: PreparedToolCall[]): Array<{
  tools: string[]
  conflictingPaths: string[]
}> {
  const conflicts: Array<{ tools: string[]; conflictingPaths: string[] }> = []
  let batchStarted = false
  let reservedPaths: ReservedPath[] = []

  for (const call of preparedCalls) {
    const classification = call.effectiveConfig?.classification

    if (classification === undefined || classification === ParallelizationClass.NEVER_PARALLEL) {
      batchStarted = false
      reservedPaths = []
      continue
    }

    if (!batchStarted) {
      batchStarted = true
    }

    if (classification !== ParallelizationClass.PATH_SCOPED) {
      continue
    }

    if (call.scopePath === null) {
      batchStarted = false
      reservedPaths = []
      continue
    }

    const overlappingPaths = reservedPaths.filter((reservedPath) =>
      pathsOverlap(reservedPath.scopePath, call.scopePath!),
    )

    if (overlappingPaths.length > 0) {
      conflicts.push({
        tools: uniqueValues([...overlappingPaths.map((path) => path.toolName), call.original.name]),
        conflictingPaths: uniqueValues([
          ...overlappingPaths.map((path) => path.scopePath),
          call.scopePath,
        ]),
      })
      reservedPaths = [{ toolName: call.original.name, scopePath: call.scopePath }]
      continue
    }

    reservedPaths.push({
      toolName: call.original.name,
      scopePath: call.scopePath,
    })
  }

  return conflicts
}

function uniqueValues(values: string[]) {
  return [...new Set(values)]
}

function isDestructiveShellCall(
  args: Record<string, unknown>,
  config: ToolParallelConfig,
): boolean {
  const command = extractShellCommand(args)

  if (command === null) {
    return true
  }

  if (matchesDestructivePattern(command, config.destructivePatterns)) {
    return true
  }

  return shouldCheckpoint("shell", { command })
}

function extractShellCommand(args: Record<string, unknown>): string | null {
  const rawCommand = args.command

  if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) {
    return null
  }

  return rawCommand.trim()
}

function matchesDestructivePattern(command: string, patterns?: readonly RegExp[]) {
  if (!patterns || patterns.length === 0) {
    return false
  }

  return patterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(command)
  })
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
