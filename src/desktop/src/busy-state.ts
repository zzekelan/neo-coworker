import type { DesktopRunStatus, DesktopSession, DesktopWorkspace } from "./view-types"

export function isBusyRunStatus(status: DesktopRunStatus | null | undefined) {
  return status === "queued" || status === "running" || status === "waiting_permission"
}

export function shouldBlockSettingsApplyFromBusyState(input: {
  hasAuthoritativeBusyState: boolean
  sessions: Pick<DesktopSession, "latestRunStatus">[]
  workspaces: Pick<DesktopWorkspace, "hasBusySession">[]
}) {
  if (!input.hasAuthoritativeBusyState) {
    return false
  }

  return (
    input.sessions.some((session) => isBusyRunStatus(session.latestRunStatus)) ||
    input.workspaces.some((workspace) => workspace.hasBusySession)
  )
}
