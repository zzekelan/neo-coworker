import type { ZodTypeAny } from "zod"
import type { OrchestrationPermissionResponse } from "./permission"

export type OrchestrationTool = {
  name: string
  description: string
  inputSchema?: ZodTypeAny
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
  metadata?: Record<string, unknown>
}

export type OrchestrationToolPort = {
  list(): OrchestrationTool[]
  execute(
    input: OrchestrationToolExecutionInput,
  ): Promise<OrchestrationToolExecutionResult> | OrchestrationToolExecutionResult
}

export type RequestOrchestrationToolPermission = (input: {
  toolName: string
  reason: string
}) =>
  | Promise<OrchestrationPermissionResponse>
  | OrchestrationPermissionResponse

export type OrchestrationToolPortFactory = {
  create(input: {
    requestPermission: RequestOrchestrationToolPermission
    sessionId: string
    runId: string
  }): OrchestrationToolPort
}
