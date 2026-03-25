import { observePermissionEvent } from "./observe"
import type { PermissionObserverPort } from "./ports/permission-observer"
import type { PermissionRepository } from "./ports/repository"

export type CreatePermissionQueryServiceInput = {
  repository: PermissionRepository
  now?: () => number
  observer?: PermissionObserverPort
}

export function createPermissionQueryService(input: CreatePermissionQueryServiceInput) {
  const repository = input.repository
  const now = input.now ?? Date.now

  return {
    getPermissionRequest(requestId: string) {
      return repository.requests.get(requestId)
    },
    listPermissionRequestsByRun(runId: string) {
      return repository.requests.listByRun(runId)
    },
    cancelPendingRequestsByRun(runId: string, resolvedAt: number = now()) {
      const cancelled = repository.requests
        .listByRun(runId)
        .filter((request) => request.status === "pending")
        .map((request) =>
          repository.requests.updateStatus({
            requestId: request.id,
            status: "cancelled",
            resolvedAt,
          }),
        )

      for (const request of cancelled) {
        observePermissionEvent(input.observer, {
          type: "permission.cancelled",
          sessionId: request.sessionId,
          runId: request.runId,
          requestId: request.id,
        })
      }

      return cancelled
    },
  }
}
