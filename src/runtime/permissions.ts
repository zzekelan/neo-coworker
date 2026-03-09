export type PermissionMode = "allow" | "ask" | "deny"

export type PermissionDecision = "allow" | "deny"

export type PermissionRequest = {
  toolName: string
  reason: string
}

export type PermissionResponse = {
  requestId: string
  decision: PermissionDecision
}

export type PendingPermissionRequest = PermissionRequest & {
  requestId: string
}

export type PermissionCoordinatorOptions = {
  onRequest?(request: PendingPermissionRequest): void
}

export type PermissionCoordinator = {
  request(input: PermissionRequest): Promise<PermissionResponse>
  resolve(input: PermissionResponse): void
  cancelAll(error?: Error): void
}

function createPermissionAbortError() {
  const error = new Error("Permission request cancelled")
  error.name = "AbortError"
  return error
}

export function createPermissionCoordinator(
  policy: Record<string, PermissionMode>,
  options: PermissionCoordinatorOptions = {},
): PermissionCoordinator {
  const pending = new Map<
    string,
    {
      resolve: (value: PermissionResponse) => void
      reject: (error: Error) => void
    }
  >()
  let nextRequestId = 1

  return {
    async request(input: PermissionRequest) {
      const mode = policy[input.toolName] ?? "deny"

      if (mode === "allow") {
        return { requestId: "permission_auto", decision: "allow" as const }
      }

      if (mode === "deny") {
        return { requestId: "permission_auto", decision: "deny" as const }
      }

      const requestId = `permission_${nextRequestId}`
      nextRequestId += 1

      const pendingRequest = {
        requestId,
        toolName: input.toolName,
        reason: input.reason,
      }

      const response = new Promise<PermissionResponse>((resolve, reject) => {
        pending.set(requestId, {
          resolve,
          reject,
        })
      })

      options.onRequest?.(pendingRequest)

      return await response
    },
    resolve(input: PermissionResponse) {
      const entry = pending.get(input.requestId)

      if (!entry) {
        throw new Error(`Unknown permission request: ${input.requestId}`)
      }

      entry.resolve(input)
      pending.delete(input.requestId)
    },
    cancelAll(error = createPermissionAbortError()) {
      for (const [requestId, entry] of pending) {
        entry.reject(error)
        pending.delete(requestId)
      }
    },
  }
}
