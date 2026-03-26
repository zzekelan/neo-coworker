export type OrchestrationPermissionMode = "allow" | "deny" | "ask"
export type OrchestrationPermissionDecision = "allow" | "deny"
export type OrchestrationPermissionStatus = "pending" | "approved" | "denied" | "cancelled"

export type OrchestrationPendingPermissionRequest = {
  requestId: string
  toolName: string
  reason: string
}

export type OrchestrationPermissionResponse = {
  requestId: string
  decision: OrchestrationPermissionDecision
}

export type OrchestrationPermissionRequestRecord = {
  id: string
  sessionId: string
  runId: string
  toolName: string
  reason: string
  status: OrchestrationPermissionStatus
}

export type OrchestrationPermissionCoordinator = {
  request(input: {
    toolName: string
    reason: string
  }): Promise<OrchestrationPermissionResponse>
  resolve(input: OrchestrationPermissionResponse): void
  cancelAll(error?: Error): void
}

export type OrchestrationPermissionPort = {
  createCoordinator(
    policy: Record<string, OrchestrationPermissionMode>,
    options?: {
      onRequest?(request: OrchestrationPendingPermissionRequest): void
    },
  ): OrchestrationPermissionCoordinator
  getPermissionRequest(requestId: string): OrchestrationPermissionRequestRecord
  requestPermission(input: {
    runId: string
    permissionRequest: {
      id?: string
      toolName: string
      reason: string
      createdAt?: number
    }
  }): {
    permissionRequest: OrchestrationPermissionRequestRecord
  }
  respondPermission(input: {
    requestId: string
    decision: OrchestrationPermissionDecision
    resolvedAt?: number
  }): {
    permissionRequest: OrchestrationPermissionRequestRecord
  }
  cancelPendingRequestsByRun(
    runId: string,
    resolvedAt: number,
  ): OrchestrationPermissionRequestRecord[]
}
