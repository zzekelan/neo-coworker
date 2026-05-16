import type { PermissionApprovalDetails, PermissionApprovalPreview } from "./approval"

export type PermissionMode = "allow" | "ask" | "deny"

export type PermissionDecision = "allow" | "deny"

export type PermissionRequest = {
  toolName: string
  reason: string
  approvalDetails?: PermissionApprovalDetails
  preview?: PermissionApprovalPreview
}

export type PermissionResponse = {
  requestId: string
  decision: PermissionDecision
}

export type PendingPermissionRequest = PermissionRequest & {
  requestId: string
}
