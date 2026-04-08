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
  concurrency?: "read-only" | "mutating"
  isConcurrencySafe?: (input: unknown) => boolean
  usageGuidance?: string
  isCompressible?: boolean
}

export type ToolDefinition = ToolCatalogEntry & {
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult> | ToolExecutionResult
  concurrency?: "read-only" | "mutating"
  isConcurrencySafe?: (input: unknown) => boolean
  usageGuidance?: string
  resultSizeLimit?: number
  isCompressible?: boolean
  timeout?: number
}
