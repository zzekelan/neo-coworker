export type PermissionConversationRun = {
  id: string
  sessionId: string
  status: string
}

export type PermissionConversationPort = {
  getRun(runId: string): PermissionConversationRun
  transitionRunToWaitingPermission(runId: string): PermissionConversationRun
  transitionRunToRunning(runId: string): PermissionConversationRun
}
