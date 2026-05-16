import { observePermissionEvent } from "./observe"
import type { PermissionObserverPort } from "./ports/permission-observer"
import type { PermissionSessionPort } from "./ports/session"
import type { CreatePermissionRequestInput, PermissionRepository } from "./ports/repository"

export type CreatePermissionRequestServiceInput = {
  repository: PermissionRepository
  session: PermissionSessionPort
  observer?: PermissionObserverPort
}

export function createPermissionRequestService(input: CreatePermissionRequestServiceInput) {
  const repository = input.repository
  const session = input.session
  let lastCreatedAt = Number.NEGATIVE_INFINITY

  return {
    requestPermission(inputValue: {
      runId: string
      permissionRequest: {
        id?: string
        toolName: string
        reason: string
        createdAt?: number
        approvalDetails?: CreatePermissionRequestInput["approvalDetails"]
        preview?: CreatePermissionRequestInput["preview"]
      }
    }) {
      const run = session.getRun(inputValue.runId)
      const permissionRequest = repository.requests.create({
        id: inputValue.permissionRequest.id,
        sessionId: run.sessionId,
        runId: run.id,
        toolName: inputValue.permissionRequest.toolName,
        reason: inputValue.permissionRequest.reason,
        createdAt: nextCreatedAt(inputValue.permissionRequest.createdAt),
        approvalDetails: inputValue.permissionRequest.approvalDetails ?? null,
        preview: inputValue.permissionRequest.preview,
        status: "pending",
        resolvedAt: null,
      })
      const nextRun = session.syncRunStatusWithPendingRequests(run.id)
      observePermissionEvent(input.observer, {
        type: "permission.requested",
        sessionId: run.sessionId,
        runId: run.id,
        requestId: permissionRequest.id,
        toolName: permissionRequest.toolName,
        reason: permissionRequest.reason,
      })

      return {
        run: nextRun,
        permissionRequest,
      }
    },
  }

  function nextCreatedAt(candidate: number | undefined) {
    if (candidate === undefined) {
      return undefined
    }

    if (candidate <= lastCreatedAt) {
      lastCreatedAt += 1
      return lastCreatedAt
    }

    lastCreatedAt = candidate
    return candidate
  }
}
