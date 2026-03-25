import { observePermissionEvent } from "./observe"
import type { PermissionObserverPort } from "./ports/permission-observer"
import type { PermissionSessionPort } from "./ports/session"
import type { PermissionRepository } from "./ports/repository"

export type CreatePermissionRequestServiceInput = {
  repository: PermissionRepository
  session: PermissionSessionPort
  observer?: PermissionObserverPort
}

export function createPermissionRequestService(input: CreatePermissionRequestServiceInput) {
  const repository = input.repository
  const session = input.session

  return {
    requestPermission(inputValue: {
      runId: string
      permissionRequest: {
        id?: string
        toolName: string
        reason: string
        createdAt?: number
      }
    }) {
      const run = session.transitionRunToWaitingPermission(inputValue.runId)
      try {
        const permissionRequest = repository.requests.create({
          id: inputValue.permissionRequest.id,
          sessionId: run.sessionId,
          runId: run.id,
          toolName: inputValue.permissionRequest.toolName,
          reason: inputValue.permissionRequest.reason,
          createdAt: inputValue.permissionRequest.createdAt,
          status: "pending",
          resolvedAt: null,
        })
        observePermissionEvent(input.observer, {
          type: "permission.requested",
          sessionId: run.sessionId,
          runId: run.id,
          requestId: permissionRequest.id,
          toolName: permissionRequest.toolName,
          reason: permissionRequest.reason,
        })

        return {
          run,
          permissionRequest,
        }
      } catch (error) {
        session.transitionRunToRunning(run.id)
        throw error
      }
    },
  }
}
