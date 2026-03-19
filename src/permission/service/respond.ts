import type { PermissionSessionPort } from "../ports/session"
import type { PermissionRepository, StoredPermissionRequest } from "../repo"

export class PermissionRequestNotPendingError extends Error {
  readonly requestId: string
  readonly status: StoredPermissionRequest["status"]

  constructor(input: { requestId: string; status: StoredPermissionRequest["status"] }) {
    super(`Permission request ${input.requestId} is not pending (status: ${input.status})`)
    this.name = "PermissionRequestNotPendingError"
    this.requestId = input.requestId
    this.status = input.status
  }
}

export class PermissionRequestRunStateError extends Error {
  readonly requestId: string
  readonly runId: string
  readonly runStatus: string

  constructor(input: { requestId: string; runId: string; runStatus: string }) {
    super(
      `Permission request ${input.requestId} cannot be replied while run ${input.runId} is ${input.runStatus}`,
    )
    this.name = "PermissionRequestRunStateError"
    this.requestId = input.requestId
    this.runId = input.runId
    this.runStatus = input.runStatus
  }
}

export type CreatePermissionRespondServiceInput = {
  repository: PermissionRepository
  session: PermissionSessionPort
  now?: () => number
}

export function createPermissionRespondService(input: CreatePermissionRespondServiceInput) {
  const repository = input.repository
  const session = input.session
  const now = input.now ?? Date.now

  return {
    respondPermission(inputValue: {
      requestId: string
      decision: "allow" | "deny"
      resolvedAt?: number
    }) {
      const permissionRequest = repository.requests.get(inputValue.requestId)
      if (permissionRequest.status !== "pending") {
        throw new PermissionRequestNotPendingError({
          requestId: permissionRequest.id,
          status: permissionRequest.status,
        })
      }

      const run = session.getRun(permissionRequest.runId)
      if (run.status !== "waiting_permission") {
        throw new PermissionRequestRunStateError({
          requestId: permissionRequest.id,
          runId: run.id,
          runStatus: run.status,
        })
      }

      const resolvedPermissionRequest = repository.requests.updateStatus({
        requestId: permissionRequest.id,
        status: inputValue.decision === "allow" ? "approved" : "denied",
        resolvedAt: inputValue.resolvedAt ?? now(),
      })

      return {
        run: session.transitionRunToRunning(run.id),
        permissionRequest: resolvedPermissionRequest,
      }
    },
  }
}
