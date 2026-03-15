import type {
  PendingPermissionRequest,
  PermissionDecision,
  PermissionMode,
  PermissionPolicy,
  PermissionRequest,
  PermissionResponse,
  PermissionStatus,
  StoredPermissionRequest,
} from "../config/defaults"

export type {
  PendingPermissionRequest,
  PermissionDecision,
  PermissionMode,
  PermissionPolicy,
  PermissionRequest,
  PermissionResponse,
  PermissionStatus,
  StoredPermissionRequest,
} from "../config/defaults"

export type CreatePermissionRequestInput = {
  id?: string
  sessionId: string
  runId: string
  toolName: string
  reason: string
  status?: PermissionStatus
  createdAt?: number
  resolvedAt?: number | null
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
