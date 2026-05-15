export type OrchestrationPermissionMode = "allow" | "deny" | "ask"
export type OrchestrationPermissionDecision = "allow" | "deny"
export type OrchestrationPermissionStatus = "pending" | "approved" | "denied" | "cancelled"

export type OrchestrationPermissionApprovalDetails = {
  kind: "patch"
  fileCount: number
  additions: number
  deletions: number
  files: Array<{
    path: string
    operation: "add" | "delete" | "move" | "update"
    additions: number
    deletions: number
  }>
}

export type OrchestrationPermissionPreview = {
  kind: "patch"
  text: string
  truncated: boolean
  limitBytes: number
  originalBytes: number
  displayedBytes: number
}

export type OrchestrationPendingPermissionRequest = {
  requestId: string
  toolName: string
  reason: string
  approvalDetails?: OrchestrationPermissionApprovalDetails
  preview?: OrchestrationPermissionPreview
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
  approvalDetails: OrchestrationPermissionApprovalDetails | null
  preview?: OrchestrationPermissionPreview
}

export type OrchestrationPermissionCoordinator = {
  request(input: {
    toolName: string
    reason: string
    approvalDetails?: OrchestrationPermissionApprovalDetails
    preview?: OrchestrationPermissionPreview
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
      approvalDetails?: OrchestrationPermissionApprovalDetails | null
      preview?: OrchestrationPermissionPreview
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
