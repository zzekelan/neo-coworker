import type { PermissionSessionPort } from "../ports/session"
import type { PermissionRepository } from "../repo"

export type CreatePermissionRequestServiceInput = {
  repository: PermissionRepository
  session: PermissionSessionPort
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
