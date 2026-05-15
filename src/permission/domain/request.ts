import type { PermissionApprovalDetails, PermissionApprovalPreview } from "./approval"

export const PERMISSION_STATUSES = [
  "pending",
  "approved",
  "denied",
  "cancelled",
] as const

export type PermissionStatus = (typeof PERMISSION_STATUSES)[number]

export type StoredPermissionRequest = {
  id: string
  sessionId: string
  runId: string
  toolName: string
  reason: string
  status: PermissionStatus
  createdAt: number
  resolvedAt: number | null
  approvalDetails: PermissionApprovalDetails | null
  preview?: PermissionApprovalPreview
}
