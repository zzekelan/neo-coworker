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
  | {
      type: "allowlist.checked"
      toolName: string
      matched: boolean
    }
  | {
      type: "allowlist.auto_approved"
      toolName: string
      pattern: string
      scope: "workspace"
    }
  | {
      type: "risk.assessed"
      sessionId: string
      runId: string
      toolName: string
      riskLevel: string
      patterns: string[]
      reasonSnippet: string
    }
  | {
      type: "permission.dangerous_override"
      sessionId: string
      runId: string
      toolName: string
      originalMode: "allow" | "deny" | "ask"
      riskLevel: string
    }

export type PermissionObserverPort = {
  recordPermissionEvent?(event: PermissionObserverEvent): void
}
