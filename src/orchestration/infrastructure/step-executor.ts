import type {
  OrchestrationTool,
  OrchestrationToolBatchExecutionOutcome,
  OrchestrationToolBatchExecutor,
  OrchestrationToolExecutionInput,
  OrchestrationToolExecutionResult,
  OrchestrationToolPort,
} from "../application/ports/tool"
import {
  classifyToolCalls,
  executeToolBatch,
  type ConcurrentToolDefinition,
} from "./tool-executor"

const TOOL_FAILURE_MESSAGE_METADATA_KEY = "__orchestrationToolFailureMessage"
const TOOL_PERMISSION_DENIED_METADATA_KEY = "__orchestrationToolPermissionDenied"

type CreateOrchestrationToolBatchExecutorInput = {
  manageResultSize(result: OrchestrationToolExecutionResult): OrchestrationToolExecutionResult
}

export function createOrchestrationToolBatchExecutor(
  input: CreateOrchestrationToolBatchExecutorInput,
): OrchestrationToolBatchExecutor {
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

        const toolFailureMessage = readMetadataString(result.metadata, TOOL_FAILURE_MESSAGE_METADATA_KEY)
        if (toolFailureMessage) {
          return {
            status: "failed",
            callId: call.callId,
            toolName: call.toolName,
            message: toolFailureMessage,
            permissionDenied: readMetadataBoolean(
              result.metadata,
              TOOL_PERMISSION_DENIED_METADATA_KEY,
            ),
          } satisfies OrchestrationToolBatchExecutionOutcome
        }

        return {
          status: "completed",
          callId: call.callId,
          toolName: call.toolName,
          result: input.manageResultSize(result),
          rawOutput: result.output,
        } satisfies OrchestrationToolBatchExecutionOutcome
      })
    },
  }
}

function createConcurrentToolDefinitions(input: {
  tools: OrchestrationToolPort
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

        if (isDetachedError(error)) {
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

function isDetachedError(error: unknown) {
  return error instanceof Error && error.name === "RunDetachedError"
}

function isToolPermissionDeniedError(error: unknown) {
  return error instanceof Error && error.name === "ToolPermissionDeniedError"
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string) {
  return typeof metadata?.[key] === "string" ? metadata[key] : null
}

function readMetadataBoolean(metadata: Record<string, unknown> | undefined, key: string) {
  return metadata?.[key] === true
}
