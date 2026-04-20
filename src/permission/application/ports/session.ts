export type PermissionSessionRun = {
  id: string
  sessionId: string
  status: string
}

export type PermissionSessionPort = {
  getRun(runId: string): PermissionSessionRun
  syncRunStatusWithPendingRequests(runId: string): PermissionSessionRun
}
