import type { ZodTypeAny } from "zod"
import type { ToolExecutionInput, ToolExecutionResult } from "./result"

export type ToolPermissionDecision = "allow" | "deny"

export type ToolPermissionRequest = {
  toolName: string
  reason: string
}

export type ToolPermissionResponse = {
  decision: ToolPermissionDecision
}

export type RequestToolPermission = (
  input: ToolPermissionRequest,
) => Promise<ToolPermissionResponse> | ToolPermissionResponse

export type ToolCatalogEntry = {
  name: string
  description: string
  inputSchema?: ZodTypeAny
}

export type ToolDefinition = ToolCatalogEntry & {
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult> | ToolExecutionResult
}
