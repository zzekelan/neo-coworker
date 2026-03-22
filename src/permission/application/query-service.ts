import type { PermissionRepository } from "./ports/repository"

export type CreatePermissionQueryServiceInput = {
  repository: PermissionRepository
  now?: () => number
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
      return repository.requests
        .listByRun(runId)
        .filter((request) => request.status === "pending")
        .map((request) =>
          repository.requests.updateStatus({
            requestId: request.id,
            status: "cancelled",
            resolvedAt,
          }),
        )
    },
  }
}
