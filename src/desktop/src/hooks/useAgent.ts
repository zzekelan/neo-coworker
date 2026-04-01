import { useDesktopApp } from "../useDesktopApp"
import type {
  DesktopPermissionRequest,
  DesktopSession,
  DesktopRun,
  DesktopSessionSnapshot,
  DesktopSkillCatalogEntry,
  DesktopWorkspace,
  DesktopTranscriptMessage,
} from "../view-types"
import { mapTranscriptMessage } from "../transcript-mapper"

export function useAgent() {
  const desktop = useDesktopApp()

  return {
    workspaces: desktop.workspaces.map(mapWorkspace),
    activeWorkspaceRoot: desktop.activeWorkspaceRoot,
    setActiveWorkspace(workspaceRoot: string) {
      return desktop.selectWorkspace(workspaceRoot)
    },
    sessions: desktop.sessions.map(mapSession),
    activeSessionId: desktop.activeSessionId,
    setActiveSessionId(sessionId: string) {
      return desktop.selectSession(sessionId)
    },
    createSession() {
      return desktop.createEmptySession()
    },
    createWorkspace() {
      return desktop.createWorkspaceFromDialog()
    },
    isManagingWorkspace: desktop.isManagingWorkspace,
    skills: desktop.skills.map(mapSkillCatalogEntry),
    session: desktop.sessionSnapshot ? mapSessionSnapshot(desktop.sessionSnapshot) : null,
    transcript: desktop.transcript.map(mapTranscriptMessage),
    permissionRequests: desktop.permissionRequests.map(mapPermissionRequest),
    isOnline: desktop.connection.state === "online",
    sendMessage(message: string) {
      return desktop.sendMessage(message)
    },
    cancelRun() {
      return desktop.cancelRun()
    },
    replyPermission(id: string, decision: "allow" | "deny") {
      return desktop.replyPermission(id, decision)
    },
    setSessionActiveSkills(sessionId: string, activeSkills: string[]) {
      return desktop.setSessionActiveSkills(sessionId, activeSkills)
    },
    errorMessage: desktop.actionError,
    skillWarningMessage: desktop.skillWarningMessage,
  }
}

function mapWorkspace(
  workspace: import("../types").DesktopWorkspaceSummary,
): DesktopWorkspace {
  return {
    id: workspace.workspaceRoot,
    name: workspace.name,
    workspaceRoot: workspace.workspaceRoot,
  }
}

function mapSession(
  session: import("../types").DesktopSessionSummary,
): DesktopSession {
  return {
    id: session.id,
    title: session.title,
    workspaceRoot: session.workspaceRoot,
    sessionId: session.id,
    updatedAt: toIsoString(session.updatedAt),
    activeSkills: session.activeSkills,
  }
}

function mapSessionSnapshot(snapshot: import("../types").DesktopSessionSnapshot): DesktopSessionSnapshot {
  return {
    session: {
      id: snapshot.session.id,
      activeSkills: snapshot.session.activeSkills,
    },
    latestRun: snapshot.latestRun ? mapRun(snapshot.latestRun) : undefined,
    activeRun: snapshot.activeRun ? mapRun(snapshot.activeRun) : undefined,
    status: snapshot.status,
  }
}

function mapRun(run: import("../types").DesktopRun): DesktopRun {
  return {
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    createdAt: toIsoString(run.createdAt),
    activeSkills: run.activeSkills,
  }
}

function mapSkillCatalogEntry(
  skill: import("../types").DesktopSkillCatalogEntry,
): DesktopSkillCatalogEntry {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
  }
}

function mapPermissionRequest(
  request: import("../types").DesktopPermissionRequest,
): DesktopPermissionRequest {
  return {
    id: request.id,
    sessionId: request.sessionId,
    runId: request.runId,
    status: request.status,
    toolName: request.toolName,
    reason: request.reason,
    createdAt: toIsoString(request.createdAt),
    resolvedAt: request.resolvedAt === null ? null : toIsoString(request.resolvedAt),
  }
}

function toIsoString(value: number) {
  return new Date(value).toISOString()
}
