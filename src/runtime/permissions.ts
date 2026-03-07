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

export type PermissionCoordinator = {
  request(input: PermissionRequest): Promise<PermissionResponse>
  resolve(input: PermissionResponse): void
}

export function createPermissionCoordinator(
  policy: Record<string, PermissionMode>,
): PermissionCoordinator {
  const pending = new Map<
    string,
    {
      resolve: (value: PermissionResponse) => void
    }
  >()

  return {
    async request(input: PermissionRequest) {
      const mode = policy[input.toolName] ?? "deny"

      if (mode === "allow") {
        return { requestId: "permission_auto", decision: "allow" as const }
      }

      if (mode === "deny") {
        return { requestId: "permission_auto", decision: "deny" as const }
      }

      const requestId = `permission_${pending.size + 1}`

      return await new Promise<PermissionResponse>((resolve) => {
        pending.set(requestId, { resolve })
      })
    },
    resolve(input: PermissionResponse) {
      pending.get(input.requestId)?.resolve(input)
      pending.delete(input.requestId)
    },
  }
}
