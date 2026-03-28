import { useDesktopApp } from "../useDesktopApp"
import type {
  DesktopPermissionRequest,
  DesktopProject,
  DesktopRun,
  DesktopSessionSnapshot,
  DesktopThread,
  DesktopTranscriptMessage,
} from "../view-types"
import { mapTranscriptMessage } from "../transcript-mapper"

export function useAgent() {
  const desktop = useDesktopApp()

  return {
    projects: desktop.projects.map(mapProject),
    activeWorkspace: desktop.activeProjectRoot,
    setActiveWorkspace(workspaceRoot: string) {
      return desktop.selectWorkspace(workspaceRoot)
    },
    threads: desktop.threads.map(mapThread),
    activeThreadId: desktop.activeSessionId,
    setActiveThreadId(threadId: string) {
      return desktop.selectSession(threadId)
    },
    createThread() {
      return desktop.createEmptyThread()
    },
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
    errorMessage: desktop.actionError,
  }
}

function mapProject(project: import("../types").DesktopProject): DesktopProject {
  return {
    id: project.workspaceRoot,
    name: project.name,
    workspaceRoot: project.workspaceRoot,
  }
}

function mapThread(thread: import("../types").DesktopThread): DesktopThread {
  return {
    id: thread.id,
    title: thread.title,
    workspaceRoot: thread.workspaceRoot,
    sessionId: thread.id,
    updatedAt: toIsoString(thread.updatedAt),
  }
}

function mapSessionSnapshot(snapshot: import("../types").DesktopSessionSnapshot): DesktopSessionSnapshot {
  return {
    session: {
      id: snapshot.session.id,
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
