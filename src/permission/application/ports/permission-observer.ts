export type PermissionObserverEvent =
  | {
      type: "permission.requested"
      sessionId: string
      runId: string
      requestId: string
      toolName: string
      reason: string
    }
  | {
      type: "permission.responded"
      sessionId: string
      runId: string
      requestId: string
      decision: "allow" | "deny"
    }
  | {
      type: "permission.cancelled"
      sessionId: string
      runId: string
      requestId: string
    }

export type PermissionObserverPort = {
  recordPermissionEvent?(event: PermissionObserverEvent): void
}
