import {
  TOOL_FAILURE_MESSAGE_METADATA_KEY,
  TOOL_PERMISSION_DENIED_METADATA_KEY,
  type OrchestrationBatchExecutionResult,
  type OrchestrationTool,
  type OrchestrationToolCallRequest,
  type OrchestrationToolExecutionInput,
  type OrchestrationToolExecutionResult,
  type OrchestrationToolPort,
} from "../application/ports/tool"
import {
  classifyToolCalls,
  executeToolBatch,
  type ConcurrentToolDefinition,
} from "./tool-executor"

export function createOrchestrationToolBatchExecutor(): {
  execute(input: {
    calls: OrchestrationToolCallRequest[]
    tools: Pick<OrchestrationToolPort, "execute">
    availableTools: OrchestrationTool[]
    workspaceRoot: string
    signal: AbortSignal
  }): Promise<OrchestrationBatchExecutionResult[]>
} {
  return {
    async execute(executeInput) {
      const executionTools = createConcurrentToolDefinitions({
        tools: executeInput.tools,
        availableTools: executeInput.availableTools,
        signal: executeInput.signal,
      })
      const batch = classifyToolCalls(executeInput.calls, executionTools)
      const results = await executeToolBatch(
        batch,
        executionTools,
        executeInput.workspaceRoot,
        executeInput.signal,
      )

      return results.map((result, index) => {
        const call = executeInput.calls[index]
        if (!call) {
          throw new Error(`Missing tool call for result index ${index}`)
        }

        return {
          callId: call.callId,
          toolName: call.toolName,
          output: result.output,
          isError: result.isError,
          metadata: result.metadata,
        } satisfies OrchestrationBatchExecutionResult
      })
    },
  }
}

function createConcurrentToolDefinitions(input: {
  tools: Pick<OrchestrationToolPort, "execute">
  availableTools: OrchestrationTool[]
  signal: AbortSignal
}): ConcurrentToolDefinition[] {
  return input.availableTools.map((tool) => ({
    ...tool,
    execute: async (toolInput) => {
      try {
        return await input.tools.execute(toolInput)
      } catch (error) {
        if (isAbortError(error, input.signal)) {
          throw error
        }

        return {
          output: "",
          isError: true,
          metadata: {
            [TOOL_FAILURE_MESSAGE_METADATA_KEY]: `Tool ${toolInput.toolName} failed: ${getErrorMessage(error)}`,
            [TOOL_PERMISSION_DENIED_METADATA_KEY]: isToolPermissionDeniedError(error),
          },
        }
      }
    },
  }))
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof Error && error.name === "AbortError")
}

function isToolPermissionDeniedError(error: unknown) {
  return error instanceof Error && error.name === "ToolPermissionDeniedError"
}
