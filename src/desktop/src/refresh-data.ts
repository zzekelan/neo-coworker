import type {
  DesktopMessage,
  DesktopPermissionRequest,
  DesktopRun,
  DesktopSessionSnapshot,
  DesktopSessionSummary,
  DesktopSkillCatalogEntry,
  DesktopWorkspaceSummary,
} from "./types"
import { normalizeTimeline } from "./timeline-state"

type DesktopRefreshLoaders = {
  loadWorkspaces(): Promise<{ workspaces: DesktopWorkspaceSummary[] }>
  loadWorkspaceSessions(workspaceRoot: string): Promise<{ sessions: DesktopSessionSummary[] }>
  loadWorkspaceSkills(workspaceRoot: string): Promise<{ skills: DesktopSkillCatalogEntry[] }>
  loadSession(sessionId: string): Promise<DesktopSessionSnapshot>
  loadTimeline(sessionId: string): Promise<{ timeline: DesktopMessage[] }>
  loadSessionRuns(sessionId: string): Promise<{ runs: DesktopRun[] }>
  loadRun(runId: string): Promise<{
    run: DesktopRun
    permissionRequests: DesktopPermissionRequest[]
  }>
}

export type DesktopRefreshCoreResult = {
  workspaces: DesktopWorkspaceSummary[]
  resolvedWorkspaceRoot: string | null
  sessions: DesktopSessionSummary[]
  activeSessionId: string | null
  snapshot: DesktopSessionSnapshot | null
  sessionRuns: DesktopRun[]
  timeline: DesktopMessage[]
  permissionRequests: DesktopPermissionRequest[]
  sessionRestoreError: unknown
  loadSkills(): Promise<{
    skills: DesktopSkillCatalogEntry[]
    warningMessage: string | null
  }>
}

export async function loadDesktopRefreshCore(input: {
  loaders: DesktopRefreshLoaders
  knownWorkspaces: ReadonlyMap<string, DesktopWorkspaceSummary>
  requestedWorkspaceRoot: string | null
  preferredSessionId: string | null
}): Promise<DesktopRefreshCoreResult> {
  const workspaceData = await input.loaders.loadWorkspaces()
  const workspaces = mergeWorkspaces(workspaceData.workspaces, input.knownWorkspaces)
  const resolvedWorkspaceRoot =
    input.requestedWorkspaceRoot &&
    workspaces.some((workspace) => workspace.workspaceRoot === input.requestedWorkspaceRoot)
      ? input.requestedWorkspaceRoot
      : workspaces[0]?.workspaceRoot ?? null
  const sessionData = resolvedWorkspaceRoot
    ? await input.loaders.loadWorkspaceSessions(resolvedWorkspaceRoot)
    : { sessions: [] }
  const activeSessionId = chooseActiveSessionId({
    preferredSessionId: input.preferredSessionId,
    sessions: sessionData.sessions,
  })

  let snapshot: DesktopSessionSnapshot | null = null
  let sessionRuns: DesktopRun[] = []
  let timeline: DesktopMessage[] = []
  let permissionRequests: DesktopPermissionRequest[] = []
  let sessionRestoreError: unknown = null

  if (activeSessionId) {
    try {
      snapshot = await input.loaders.loadSession(activeSessionId)
      const runsData = await input.loaders.loadSessionRuns(activeSessionId)
      sessionRuns = runsData.runs
      const timelineData = await input.loaders.loadTimeline(activeSessionId)
      timeline = normalizeTimeline(timelineData.timeline)

      if (snapshot.activeRun) {
        const runState = await input.loaders.loadRun(snapshot.activeRun.id)
        permissionRequests = runState.permissionRequests
          .filter((request) => request.status === "pending")
          .sort((left, right) => {
            if (left.createdAt !== right.createdAt) {
              return left.createdAt - right.createdAt
            }
            if (left.id < right.id) return -1
            if (left.id > right.id) return 1
            return 0
          })
      }
    } catch (error) {
      sessionRestoreError = error
    }
  }

  return {
    workspaces,
    resolvedWorkspaceRoot,
    sessions: sessionData.sessions,
    activeSessionId,
    snapshot,
    sessionRuns,
    timeline,
    permissionRequests,
    sessionRestoreError,
    async loadSkills() {
      if (!resolvedWorkspaceRoot) {
        return {
          skills: [],
          warningMessage: null,
        }
      }

      try {
        const skillData = await input.loaders.loadWorkspaceSkills(resolvedWorkspaceRoot)
        return {
          skills: skillData.skills,
          warningMessage: null,
        }
      } catch (error) {
        return {
          skills: [],
          warningMessage: toSkillWarningMessage(error),
        }
      }
    },
  }
}

export function chooseActiveSessionId(input: {
  preferredSessionId: string | null | undefined
  sessions: DesktopSessionSummary[]
}) {
  if (
    input.preferredSessionId &&
    input.sessions.some((session) => session.id === input.preferredSessionId)
  ) {
    return input.preferredSessionId
  }

  return input.sessions[0]?.id ?? null
}

export function mergeWorkspaces(
  workspaces: DesktopWorkspaceSummary[],
  knownWorkspaces: ReadonlyMap<string, DesktopWorkspaceSummary>,
) {
  const merged = new Map(knownWorkspaces)

  for (const workspace of workspaces) {
    merged.set(workspace.workspaceRoot, workspace)
  }

  return [...merged.values()].sort((left, right) => right.latestActivityAt - left.latestActivityAt)
}

export function toSkillWarningMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return `Could not load workspace skills: ${message}`
}
