import type { ZodTypeAny } from "zod"
import type {
  OrchestrationPermissionApprovalDetails,
  OrchestrationPermissionPreview,
  OrchestrationPermissionResponse,
} from "./permission"

export type OrchestrationTool = {
  name: string
  description: string
  inputSchema?: ZodTypeAny
  concurrency?: "read-only" | "mutating"
  isConcurrencySafe?: (input: unknown) => boolean
  usageGuidance?: string
  isCompressible?: boolean
}

export type OrchestrationToolExecutionInput = {
  toolName: string
  args: unknown
  workspaceRoot: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export type OrchestrationToolExecutionResult = {
  output: string
  isError?: boolean
  errorCode?: string
  metadata?: Record<string, unknown>
}

export const TOOL_FAILURE_MESSAGE_METADATA_KEY = "__orchestrationToolFailureMessage"
export const TOOL_PERMISSION_DENIED_METADATA_KEY = "__orchestrationToolPermissionDenied"
export const TOOL_PERMISSION_DENIED_ERROR_CODE = "TOOL_PERMISSION_DENIED"
export const AGENT_TOOL_DENIED_ERROR_CODE = "AGENT_TOOL_DENIED"
export const TOOL_RECOVERABLE_UNKNOWN_METADATA_KEY = "__orchestrationRecoverableUnknownTool"
export const TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY = "__orchestrationUnknownToolAllowedNames"

export type OrchestrationToolCallRequest = {
  callId: string
  toolName: string
  args: unknown
  onProgress?: (message: string) => void
}

export type OrchestrationBatchExecutionResult = {
  callId: string
  toolName: string
  output: string
  isError?: boolean
  errorCode?: string
  metadata?: Record<string, unknown>
}

export type OrchestrationToolPort = {
  list(): OrchestrationTool[]
  listCatalog?(): OrchestrationTool[]
  execute(
    input: OrchestrationToolExecutionInput,
  ): Promise<OrchestrationToolExecutionResult> | OrchestrationToolExecutionResult
  executeBatch(input: {
    calls: OrchestrationToolCallRequest[]
    workspaceRoot: string
    signal: AbortSignal
  }): Promise<OrchestrationBatchExecutionResult[]>
}

export type RequestOrchestrationToolPermission = (input: {
  toolName: string
  reason: string
  approvalDetails?: OrchestrationPermissionApprovalDetails
  preview?: OrchestrationPermissionPreview
}) =>
  | Promise<OrchestrationPermissionResponse>
  | OrchestrationPermissionResponse

export type OrchestrationToolPortFactory = {
  create(input: {
    requestPermission: RequestOrchestrationToolPermission
    sessionId: string
    runId: string
    resolveThinking?: (sessionId: string) => {
      enabled: boolean
      effort?: "default" | "low" | "medium" | "high"
    } | undefined
    forwardRuntimeEvent?(event: { type: string; [key: string]: unknown }): void
  }): OrchestrationToolPort
}
