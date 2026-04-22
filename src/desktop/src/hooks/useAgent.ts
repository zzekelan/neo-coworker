import { useDesktopApp } from "../useDesktopApp"
import type {
  DesktopPermissionRequest,
  DesktopSession,
  DesktopRun,
  DesktopSessionSnapshot,
  DesktopSkillCatalogEntry,
  DesktopWorkspace,
  DesktopTranscriptMessage,
  DesktopContextUsage,
  DesktopPrimaryAgent,
} from "../view-types"
import { mapTranscriptMessage } from "../transcript-mapper"
import { getNextPrimaryAgent } from "../agent-cycle"

export function useAgent() {
  const desktop = useDesktopApp()
  const runStatusById = new Map(desktop.sessionRuns.map((run) => [run.id, run.status]))
  const subagentRunIds = new Set(
    desktop.sessionRuns.filter((run) => run.parentRunId != null).map((run) => run.id),
  )

  const setCurrentAgent = (agentName: string) => {
    const sessionId = desktop.activeSessionId
    if (!sessionId) return
    void desktop.setSessionAgent(sessionId, agentName)
  }

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
    deleteSession(sessionId: string) {
      return desktop.deleteSession(sessionId)
    },
    isManagingWorkspace: desktop.isManagingWorkspace,
    skills: desktop.skills.map(mapSkillCatalogEntry),
    session: desktop.sessionSnapshot ? mapSessionSnapshot(desktop.sessionSnapshot) : null,
    transcript: mergeConsecutiveToolMessages(
      desktop.transcript
        .filter((message) => !subagentRunIds.has(message.runId))
        .map((message) =>
          mapTranscriptMessage(message, {
            runStatusById,
          }),
        ),
    ),
    permissionRequests: desktop.permissionRequests.map(mapPermissionRequest),
    isOnline: desktop.connection.state === "online",
    hasAuthoritativeBusyState: desktop.hasAuthoritativeWorkspaceBusyState,
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
    currentAgent: desktop.currentAgent,
    primaryAgents: desktop.primaryAgents.map(mapPrimaryAgent),
    setCurrentAgent,
    setAgent(agentName: string) {
      setCurrentAgent(agentName)
    },
    cycleAgent() {
      const next = getNextPrimaryAgent(desktop.currentAgent, desktop.primaryAgents)
      if (!desktop.activeSessionId) return
      if (next !== desktop.currentAgent) {
        setCurrentAgent(next)
      }
    },
    errorMessage: desktop.actionError,
    skillWarningMessage: desktop.skillWarningMessage,
    compatibilityPrompt: desktop.compatibilityPrompt,
    dismissCompatibilityPrompt() {
      desktop.dismissCompatibilityPrompt()
    },
    continueWithoutThinking() {
      return desktop.continueSessionWithoutThinking()
    },
    contextUsage: desktop.contextUsage ? mapContextUsage(desktop.contextUsage) : null,
    refreshAppState() {
      return desktop.refreshAppState()
    },
  }
}

function mapWorkspace(
  workspace: import("../types").DesktopWorkspaceSummary,
): DesktopWorkspace {
  return {
    id: workspace.workspaceRoot,
    name: workspace.name,
    workspaceRoot: workspace.workspaceRoot,
    hasBusySession: workspace.hasBusySession,
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
    createdAt: toIsoString(session.createdAt),
    updatedAt: toIsoString(session.updatedAt),
    activeSkills: session.activeSkills,
    currentAgent: session.currentAgent,
    latestRunStatus: session.latestRunStatus,
  }
}

function mapSessionSnapshot(snapshot: import("../types").DesktopSessionSnapshot): DesktopSessionSnapshot {
  return {
    session: {
      id: snapshot.session.id,
      activeSkills: snapshot.session.activeSkills,
      currentAgent: snapshot.session.currentAgent,
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
    parentRunId: run.parentRunId ?? undefined,
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

function mapContextUsage(
  usage: { contextTokens: number; contextWindow: number; utilizationPercent: number; source: "provider" | "estimated" | null },
): DesktopContextUsage {
  return {
    contextTokens: usage.contextTokens,
    contextWindow: usage.contextWindow,
    utilizationPercent: usage.utilizationPercent,
    source: usage.source,
  }
}

function mapPrimaryAgent(
  agent: { name: string; description: string },
): DesktopPrimaryAgent {
  return {
    name: agent.name,
    description: agent.description,
  }
}

function isToolOnlyMessage(msg: DesktopTranscriptMessage): boolean {
  return msg.role === "assistant" && !!msg.parts && msg.parts.length > 0 && msg.parts.every((p) => p.type === "tool_call" || p.type === "tool_result")
}

/** Merge consecutive assistant messages that contain only tool calls into a single message for grouping. */
function mergeConsecutiveToolMessages(messages: DesktopTranscriptMessage[]): DesktopTranscriptMessage[] {
  const result: DesktopTranscriptMessage[] = []
  for (const msg of messages) {
    const prev = result[result.length - 1]
    if (isToolOnlyMessage(msg) && prev && isToolOnlyMessage(prev)) {
      result[result.length - 1] = {
        ...prev,
        parts: [...(prev.parts ?? []), ...(msg.parts ?? [])],
      }
    } else {
      result.push(msg)
    }
  }
  return result
}
