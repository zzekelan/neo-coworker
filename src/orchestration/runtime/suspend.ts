import type {
  CreateOrchestrationRuntimeApiInput,
  OrchestrationEventEmitter,
  OrchestrationResolvedPermissionPolicy,
  OrchestrationRunSuspension,
} from "../service/runtime"

type CreateRunSuspensionInput = {
  permission: CreateOrchestrationRuntimeApiInput["permission"]
  runId: string
  sessionId: string
  policy: OrchestrationResolvedPermissionPolicy
  now: () => number
  emit: OrchestrationEventEmitter
}

export class PermissionRequestNotAwaitingActiveRuntimeError extends Error {
  readonly requestId: string
  readonly runId: string
  readonly sessionId: string

  constructor(input: { requestId: string; runId: string; sessionId: string }) {
    super(`Permission request ${input.requestId} is not awaiting a reply in the active runtime`)
    this.name = "PermissionRequestNotAwaitingActiveRuntimeError"
    this.requestId = input.requestId
    this.runId = input.runId
    this.sessionId = input.sessionId
  }
}

export function createRunSuspension(input: CreateRunSuspensionInput): OrchestrationRunSuspension {
  const pendingPermissionIds = new Set<string>()
  const coordinator = input.permission.createCoordinator(input.policy, {
    onRequest(request) {
      input.permission.requestPermission({
        runId: input.runId,
        permissionRequest: {
          id: request.requestId,
          toolName: request.toolName,
          reason: request.reason,
          createdAt: input.now(),
        },
      })
      pendingPermissionIds.add(request.requestId)
      input.emit({
        type: "permission.requested",
        requestId: request.requestId,
        toolName: request.toolName,
        reason: request.reason,
      })
    },
  })

  return {
    isPending(requestId: string) {
      return pendingPermissionIds.has(requestId)
    },
    requestPermission(request) {
      return coordinator.request(request)
    },
    respond(response) {
      const permissionRequest = input.permission.getPermissionRequest(response.requestId)
      if (!pendingPermissionIds.has(response.requestId)) {
        if (permissionRequest.status !== "pending") {
          input.permission.respondPermission({
            requestId: response.requestId,
            decision: response.decision,
            resolvedAt: input.now(),
          })
        }

        throw new PermissionRequestNotAwaitingActiveRuntimeError({
          requestId: permissionRequest.id,
          runId: permissionRequest.runId,
          sessionId: permissionRequest.sessionId,
        })
      }

      input.permission.respondPermission({
        requestId: response.requestId,
        decision: response.decision,
        resolvedAt: input.now(),
      })
      pendingPermissionIds.delete(response.requestId)
      coordinator.resolve(response)
    },
    cancel(error?: Error) {
      pendingPermissionIds.clear()
      coordinator.cancelAll(error)
    },
  }
}
