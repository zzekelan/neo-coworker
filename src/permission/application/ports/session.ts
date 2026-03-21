export type PermissionSessionRun = {
  id: string
  sessionId: string
  status: string
}

export type PermissionSessionPort = {
  getRun(runId: string): PermissionSessionRun
  transitionRunToWaitingPermission(runId: string): PermissionSessionRun
  transitionRunToRunning(runId: string): PermissionSessionRun
}
