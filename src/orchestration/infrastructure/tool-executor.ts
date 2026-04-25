import type {
  OrchestrationToolExecutionInput,
  OrchestrationToolExecutionResult,
} from "../application/ports/tool"
import {
  TOOL_RECOVERABLE_UNKNOWN_METADATA_KEY,
  TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY,
} from "../application/ports/tool"

type ToolConcurrency = "read-only" | "mutating"

export type ConcurrentToolCall = {
  callId: string
  toolName: string
  args: unknown
  onProgress?: (message: string) => void
}

export type ConcurrentToolDefinition = {
  name: string
  description: string
  execute(
    input: OrchestrationToolExecutionInput,
  ): Promise<OrchestrationToolExecutionResult> | OrchestrationToolExecutionResult
  concurrency?: ToolConcurrency
  isConcurrencySafe?: (input: unknown) => boolean
}

export type ClassifiedToolCall = ConcurrentToolCall & {
  index: number
  concurrency: ToolConcurrency
  recoverableUnknown?: {
    allowedToolNames: string[]
  }
}

export type ToolExecutionBatch = {
  calls: ClassifiedToolCall[]
  readOnly: ClassifiedToolCall[]
  mutating: ClassifiedToolCall[]
}

export function classifyToolCalls(
  calls: ConcurrentToolCall[],
  registry: ConcurrentToolDefinition[],
): ToolExecutionBatch {
  const toolMap = new Map(registry.map((tool) => [tool.name, tool]))
  const allowedToolNames = registry.map((tool) => tool.name)
  const classifiedCalls = calls.map((call, index) => {
    const tool = toolMap.get(call.toolName)
    if (!tool) {
      return {
        ...call,
        index,
        concurrency: "mutating" as const,
        recoverableUnknown: {
          allowedToolNames,
        },
      }
    }

    return {
      ...call,
      index,
      concurrency: resolveToolConcurrency(tool, call.args),
    }
  })

  return {
    calls: classifiedCalls,
    readOnly: classifiedCalls.filter((call) => call.concurrency === "read-only"),
    mutating: classifiedCalls.filter((call) => call.concurrency === "mutating"),
  }
}

export async function executeToolBatch(
  batch: ToolExecutionBatch,
  tools: ConcurrentToolDefinition[],
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<OrchestrationToolExecutionResult[]> {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]))
  const results = new Array<OrchestrationToolExecutionResult>(batch.calls.length)

  ensureNotAborted(signal)

  await Promise.all(
    batch.readOnly.map(async (call) => {
      results[call.index] = await executeSingleTool({
        call,
        toolMap,
        workspaceRoot,
        signal,
      })
    }),
  )

  for (const call of batch.mutating) {
    ensureNotAborted(signal)
    results[call.index] = await executeSingleTool({
      call,
      toolMap,
      workspaceRoot,
      signal,
    })
  }

  return results.map((result, index) => {
    if (!result) {
      throw new Error(`Missing tool result for call index ${index}`)
    }

    return result
  })
}

function resolveToolConcurrency(
  tool: ConcurrentToolDefinition,
  input: unknown,
): ToolConcurrency {
  if (tool.isConcurrencySafe) {
    try {
      return tool.isConcurrencySafe(input) ? "read-only" : "mutating"
    } catch {
      return "mutating"
    }
  }

  return tool.concurrency ?? "mutating"
}

async function executeSingleTool(input: {
  call: ClassifiedToolCall
  toolMap: Map<string, ConcurrentToolDefinition>
  workspaceRoot: string
  signal: AbortSignal
}) {
  ensureNotAborted(input.signal)

  const tool = input.toolMap.get(input.call.toolName)
  if (!tool) {
    if (input.call.recoverableUnknown) {
      return createRecoverableUnknownToolResult({
        toolName: input.call.toolName,
        allowedToolNames: input.call.recoverableUnknown.allowedToolNames,
      })
    }

    throw new Error(`Unknown tool: ${input.call.toolName}`)
  }

  return await tool.execute({
    toolName: input.call.toolName,
    args: input.call.args,
    workspaceRoot: input.workspaceRoot,
    signal: input.signal,
    onProgress: input.call.onProgress,
  })
}

function createRecoverableUnknownToolResult(input: {
  toolName: string
  allowedToolNames: string[]
}): OrchestrationToolExecutionResult {
  const allowedToolList = input.allowedToolNames.length > 0
    ? input.allowedToolNames.join(", ")
    : "none"

  return {
    output: `Tool '${input.toolName}' is not available. Allowed tools: ${allowedToolList}. Use one of the allowed tools instead.`,
    isError: true,
    metadata: {
      [TOOL_RECOVERABLE_UNKNOWN_METADATA_KEY]: true,
      [TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY]: input.allowedToolNames,
    },
  }
}

function ensureNotAborted(signal: AbortSignal) {
  if (!signal.aborted) {
    return
  }

  const reason = signal.reason
  if (reason instanceof Error) {
    throw reason
  }

  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "Operation aborted",
  )
  error.name = "AbortError"
  throw error
}
