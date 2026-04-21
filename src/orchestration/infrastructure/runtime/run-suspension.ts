import { createRequire } from "node:module"
import type { RuntimeEvent } from "../../application/event"
import type {
  OrchestrationPermissionPort,
  OrchestrationPermissionResponse,
} from "../../application/ports/permission"
import type { OrchestrationPermissionPolicy } from "../../application/permission"

type PermissionRequestNotPendingErrorConstructor = new (input: {
  requestId: string
  status: string
}) => Error

const require = createRequire(import.meta.url)
const { PermissionRequestNotPendingError: PermissionRequestNotPendingErrorBase } = require(
  "../../../permission",
) as {
  PermissionRequestNotPendingError: PermissionRequestNotPendingErrorConstructor
}

export type OrchestrationRunSuspension = {
  getPendingRequestIds(): string[]
  isPending(requestId: string): boolean
  requestPermission(input: {
    toolName: string
    reason: string
  }): Promise<OrchestrationPermissionResponse>
  respond(input: OrchestrationPermissionResponse): void
  cancel(error?: Error): void
}

type CreateRunSuspensionInput = {
  permission: OrchestrationPermissionPort
  runId: string
  sessionId: string
  policy: OrchestrationPermissionPolicy
  now: () => number
  emit: (event: RuntimeEvent) => void
}

export class PermissionRequestNotAwaitingActiveRuntimeError extends PermissionRequestNotPendingErrorBase {
  readonly requestId: string
  readonly runId: string
  readonly sessionId: string
  readonly status: string

  constructor(input: { requestId: string; runId: string; sessionId: string; status: string }) {
    super({
      requestId: input.requestId,
      status: input.status,
    })
    this.name = "PermissionRequestNotAwaitingActiveRuntimeError"
    this.requestId = input.requestId
    this.runId = input.runId
    this.sessionId = input.sessionId
    this.status = input.status
    this.message = buildNotAwaitingActiveRuntimeMessage(input)
  }
}

function buildNotAwaitingActiveRuntimeMessage(input: {
  requestId: string
  status: string
}) {
  if (input.status === "pending") {
    return `Permission request ${input.requestId} is not awaiting a reply in the active runtime (stored status: pending)`
  }

  return `Permission request ${input.requestId} is not awaiting a reply in the active runtime (request is not pending: ${input.status})`
}

function throwPermissionRequestNotAwaitingActiveRuntime(
  permissionRequest: ReturnType<OrchestrationPermissionPort["getPermissionRequest"]>,
): never {
  throw new PermissionRequestNotAwaitingActiveRuntimeError({
    requestId: permissionRequest.id,
    runId: permissionRequest.runId,
    sessionId: permissionRequest.sessionId,
    status: permissionRequest.status,
  })
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
    getPendingRequestIds() {
      return [...pendingPermissionIds]
    },
    isPending(requestId: string) {
      return pendingPermissionIds.has(requestId)
    },
    requestPermission(request) {
      return coordinator.request(request)
    },
    respond(response) {
      const permissionRequest = input.permission.getPermissionRequest(response.requestId)
      if (!pendingPermissionIds.has(response.requestId)) {
        throwPermissionRequestNotAwaitingActiveRuntime(permissionRequest)
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
