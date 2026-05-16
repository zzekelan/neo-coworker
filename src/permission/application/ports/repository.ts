export type PermissionStatus = "pending" | "approved" | "denied" | "cancelled"

type PermissionApprovalDetails = {
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

type PermissionApprovalPreview = {
  kind: "patch"
  text: string
  truncated: boolean
  limitBytes: number
  originalBytes: number
  displayedBytes: number
}

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

export type CreatePermissionRequestInput = {
  id?: string
  sessionId: string
  runId: string
  toolName: string
  reason: string
  status?: PermissionStatus
  createdAt?: number
  resolvedAt?: number | null
  approvalDetails?: PermissionApprovalDetails | null
  preview?: PermissionApprovalPreview
}

export type UpdatePermissionRequestStatusInput = {
  requestId: string
  status: PermissionStatus
  resolvedAt?: number | null
}

export class PermissionRepositoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PermissionRepositoryError"
  }
}

export class PermissionNotFoundError extends PermissionRepositoryError {
  readonly requestId: string

  constructor(requestId: string) {
    super(`Unknown permission_request: ${requestId}`)
    this.name = "PermissionNotFoundError"
    this.requestId = requestId
  }
}

export type PermissionRepository = {
  requests: {
    create(input: CreatePermissionRequestInput): StoredPermissionRequest
    get(requestId: string): StoredPermissionRequest
    listByRun(runId: string): StoredPermissionRequest[]
    updateStatus(input: UpdatePermissionRequestStatusInput): StoredPermissionRequest
  }
}
