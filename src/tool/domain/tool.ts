import type { ZodTypeAny } from "zod"
import type { ToolExecutionInput, ToolExecutionResult } from "./result"

export type ToolPermissionDecision = "allow" | "deny"

export type ToolPermissionApprovalDetails = {
  kind: "patch"
  fileCount: number
  additions: number
  deletions: number
  files: Array<{
    path: string
    operation: "add" | "delete" | "move" | "update"
    additions: number
    deletions: number
  }>
}

export type ToolPermissionPreview = {
  kind: "patch"
  text: string
  truncated: boolean
  limitBytes: number
  originalBytes: number
  displayedBytes: number
}

export type ToolPermissionRequest = {
  toolName: string
  reason: string
  approvalDetails?: ToolPermissionApprovalDetails
  preview?: ToolPermissionPreview
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
  resultSizeLimit?: number
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
