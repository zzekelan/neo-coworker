import { useEffect, useEffectEvent, useRef, useState } from "react"
import {
  cancelRun,
  createSession,
  deleteSession as deleteSessionRequest,
  getDesktopBridge,
  loadWorkspaces,
  loadWorkspaceSkills,
  loadRun,
  loadSessionRuns,
  loadSession,
  loadWorkspaceSessions,
  loadTranscript,
  openWorkspace,
  pickDirectory,
  persistDesktopSelection,
  replyPermission,
  startRun,
  subscribeToEvents,
  updateSessionActiveSkills,
} from "./api"
import {
  upsertTranscriptMessage,
  upsertTranscriptMessagePart,
} from "./transcript-state"
import { loadDesktopRefreshCore, mergeWorkspaces } from "./refresh-data"
import type {
  ConnectionStatus,
  DesktopMessage,
  DesktopPermissionRequest,
  DesktopSkillCatalogEntry,
  DesktopSessionSummary,
  DesktopRun,
  DesktopServerEvent,
  DesktopSessionSnapshot,
  DesktopWorkspaceSummary,
} from "./types"

type AppState = {
  workspaces: DesktopWorkspaceSummary[]
  skills: DesktopSkillCatalogEntry[]
  sessions: DesktopSessionSummary[]
  activeWorkspaceRoot: string | null
  activeSessionId: string | null
  sessionSnapshot: DesktopSessionSnapshot | null
  sessionRuns: DesktopRun[]
  transcript: DesktopMessage[]
  permissionRequests: DesktopPermissionRequest[]
  connection: ConnectionStatus
  contextUsage: ContextUsageState | null
  hasAuthoritativeWorkspaceBusyState: boolean
  isLoading: boolean
  isSending: boolean
  isManagingWorkspace: boolean
  actionError: string | null
  skillWarningMessage: string | null
}

type ContextUsageState = {
  contextTokens: number
  contextWindow: number
  utilizationPercent: number
  source: "provider" | "estimated" | null
}

type RefreshOptions = {
  workspaceRoot?: string | null
  sessionId?: string | null
  preserveTranscript?: boolean
}

export function useDesktopApp() {
  const bridgeRef = useRef(getDesktopBridge())
  const bridge = bridgeRef.current
  const [state, setState] = useState<AppState>(() =>
    createInitialState({
      defaultWorkspaceRoot: bridge.defaultWorkspaceRoot,
      persistedWorkspaceRoot: bridge.persistedWorkspaceRoot,
      persistedSessionId: bridge.persistedSessionId,
    }),
  )
  const knownWorkspacesRef = useRef(createKnownWorkspacesMap({
    defaultWorkspaceRoot: bridge.defaultWorkspaceRoot,
    persistedWorkspaceRoot: bridge.persistedWorkspaceRoot,
  }))
  const selectionRef = useRef({
    activeWorkspaceRoot: state.activeWorkspaceRoot,
    activeSessionId: state.activeSessionId,
  })
  const refreshTokenRef = useRef(0)
  const workspaceRefreshTokenRef = useRef(0)

  const setSelectionRef = (nextSelection: {
    activeWorkspaceRoot: string | null
    activeSessionId: string | null
  }) => {
    selectionRef.current = nextSelection
  }

  const rememberWorkspaces = (workspaces: DesktopWorkspaceSummary[]) => {
    knownWorkspacesRef.current = new Map(
      workspaces.map((workspace) => [workspace.workspaceRoot, workspace]),
    )
    return workspaces
  }

  useEffect(() => {
    setSelectionRef({
      activeWorkspaceRoot: state.activeWorkspaceRoot,
      activeSessionId: state.activeSessionId,
    })
  }, [state.activeWorkspaceRoot, state.activeSessionId])

  useEffect(() => {
    void persistDesktopSelection({
      activeWorkspaceRoot: state.activeWorkspaceRoot,
      activeSessionId: state.activeSessionId,
    }).catch(() => {})
  }, [state.activeWorkspaceRoot, state.activeSessionId])

  const refresh = useEffectEvent(async (options: RefreshOptions = {}) => {
    const currentToken = refreshTokenRef.current + 1
    refreshTokenRef.current = currentToken

    if (!options.preserveTranscript) {
      setState((previous) => ({
        ...previous,
        isLoading: true,
        actionError: null,
        connection: previous.connection.state === "online"
          ? previous.connection
          : {
              state: "connecting",
              label: "Connecting to app-server",
              detail: bridge.apiOrigin ?? bridge.defaultWorkspaceRoot ?? "Desktop bridge",
            },
      }))
    }

    try {
      const requestedWorkspaceRoot =
        options.workspaceRoot ?? selectionRef.current.activeWorkspaceRoot ?? bridge.defaultWorkspaceRoot ?? null
      const refreshData = await loadDesktopRefreshCore({
        loaders: {
          loadWorkspaces,
          loadWorkspaceSessions,
          loadWorkspaceSkills,
          loadSession,
          loadSessionRuns,
          loadTranscript,
          loadRun,
        },
        knownWorkspaces: knownWorkspacesRef.current,
        requestedWorkspaceRoot,
        preferredSessionId: options.sessionId ?? selectionRef.current.activeSessionId,
      })

      if (currentToken !== refreshTokenRef.current) {
        return
      }

      rememberWorkspaces(refreshData.workspaces)
      setSelectionRef({
        activeWorkspaceRoot: refreshData.resolvedWorkspaceRoot,
        activeSessionId: refreshData.activeSessionId,
      })

      setState((previous) => ({
        ...previous,
        workspaces: refreshData.workspaces,
        skills:
          previous.activeWorkspaceRoot === refreshData.resolvedWorkspaceRoot
            ? previous.skills
            : [],
        sessions: refreshData.sessions,
        activeWorkspaceRoot: refreshData.resolvedWorkspaceRoot,
        activeSessionId: refreshData.activeSessionId,
        sessionSnapshot: refreshData.snapshot,
        sessionRuns: refreshData.sessionRuns,
        transcript: refreshData.transcript,
        permissionRequests: refreshData.permissionRequests,
        contextUsage: refreshData.snapshot?.contextUsage ?? null,
        connection: {
          state: "online",
          label: "Connected to app-server",
          detail: bridge.apiOrigin ?? refreshData.resolvedWorkspaceRoot ?? "Desktop bridge",
        },
        hasAuthoritativeWorkspaceBusyState: true,
        isLoading: false,
        isSending:
          refreshData.snapshot?.activeRun !== null &&
          refreshData.snapshot?.activeRun !== undefined &&
          refreshData.snapshot.activeRun.status !== "waiting_permission",
        isManagingWorkspace: false,
        actionError: refreshData.sessionRestoreError ? toErrorMessage(refreshData.sessionRestoreError) : null,
        skillWarningMessage: null,
      }))

      void refreshData.loadSkills().then((skillData) => {
        if (currentToken !== refreshTokenRef.current) {
          return
        }

        setState((previous) => ({
          ...previous,
          skills: skillData.skills,
          skillWarningMessage: skillData.warningMessage,
        }))
      })
    } catch (error) {
      if (currentToken !== refreshTokenRef.current) {
        return
      }

      setState((previous) => ({
        ...previous,
        isLoading: false,
        isSending: false,
        isManagingWorkspace: false,
        actionError: toErrorMessage(error),
        skillWarningMessage: null,
        connection: {
          state: "error",
          label: "app-server unavailable",
          detail: bridge.apiOrigin ?? bridge.defaultWorkspaceRoot ?? "Desktop bridge",
        },
        hasAuthoritativeWorkspaceBusyState: false,
      }))
    }
  })

  const syncWorkspaces = useEffectEvent(async () => {
    const currentToken = workspaceRefreshTokenRef.current + 1
    workspaceRefreshTokenRef.current = currentToken

    try {
      const workspaceData = await loadWorkspaces()
      if (currentToken !== workspaceRefreshTokenRef.current) {
        return
      }

      const workspaces = rememberWorkspaces(
        mergeWorkspaces(workspaceData.workspaces, knownWorkspacesRef.current),
      )
      setState((previous) => ({
        ...previous,
        workspaces,
        hasAuthoritativeWorkspaceBusyState: true,
      }))
    } catch {
      setState((previous) => ({
        ...previous,
        hasAuthoritativeWorkspaceBusyState: false,
      }))
    }
  })

  const handleEvent = useEffectEvent((event: DesktopServerEvent) => {
    const { activeWorkspaceRoot, activeSessionId } = selectionRef.current

    if (event.type === "heartbeat") {
      setState((previous) => ({
        ...previous,
        connection: {
          state: "online",
          label: "Connected to app-server",
          detail: bridge.apiOrigin ?? previous.activeWorkspaceRoot ?? "Desktop bridge",
        },
      }))
      return
    }

    if (
      (event.type === "session.created" || event.type === "session.updated") &&
      event.session.workspaceRoot === activeWorkspaceRoot
    ) {
      setState((previous) => ({
        ...previous,
        sessions: upsertSession(previous.sessions, event.session),
        sessionSnapshot:
          previous.activeSessionId === event.session.id
            ? {
                session: event.session,
                latestRun: event.latestRun,
                activeRun: event.activeRun,
                status: event.status,
              }
            : previous.sessionSnapshot,
      }))
      void syncWorkspaces()
      return
    }

    if (event.type === "session.created" || event.type === "session.updated") {
      void syncWorkspaces()
      return
    }

    if (event.type === "session.deleted") {
      const deletingActiveSession = activeSessionId === event.sessionId
      const nextSessions =
        activeWorkspaceRoot === event.workspaceRoot
          ? state.sessions.filter((session) => session.id !== event.sessionId)
          : state.sessions
      const nextActiveSessionId = deletingActiveSession ? nextSessions[0]?.id ?? null : activeSessionId

      if (deletingActiveSession) {
        setSelectionRef({
          activeWorkspaceRoot,
          activeSessionId: nextActiveSessionId,
        })
      }

      setState((previous) => {
        return {
          ...previous,
          sessions: nextSessions,
          activeSessionId: nextActiveSessionId,
          sessionSnapshot: deletingActiveSession ? null : previous.sessionSnapshot,
          sessionRuns: deletingActiveSession ? [] : previous.sessionRuns,
          transcript: deletingActiveSession ? [] : previous.transcript,
          permissionRequests: deletingActiveSession ? [] : previous.permissionRequests,
          isSending: deletingActiveSession ? false : previous.isSending,
        }
      })
      void syncWorkspaces()

      void refresh({
        workspaceRoot: activeWorkspaceRoot,
        sessionId: activeSessionId === event.sessionId ? null : activeSessionId,
        preserveTranscript: activeSessionId !== event.sessionId,
      })
      return
    }

    if (event.type === "message.created" && event.message.sessionId === activeSessionId) {
      setState((previous) => ({
        ...previous,
        transcript: upsertTranscriptMessage(previous.transcript, {
          ...event.message,
          parts: [],
        }),
      }))
      return
    }

    if (event.type === "message.part.updated" && event.part.sessionId === activeSessionId) {
      setState((previous) => ({
        ...previous,
        transcript: upsertTranscriptMessagePart(previous.transcript, event.part),
      }))
      return
    }

    if ((event.type === "run.created" || event.type === "run.updated") && event.run.sessionId === activeSessionId) {
      const terminal = isTerminalRunStatus(event.run.status)

      setState((previous) => ({
        ...previous,
        sessionRuns: upsertSessionRun(previous.sessionRuns, event.run),
        sessionSnapshot: previous.sessionSnapshot
          ? {
              ...previous.sessionSnapshot,
              latestRun: event.run,
              activeRun: terminal ? null : event.run,
              status: terminal ? "idle" : "busy",
            }
          : previous.sessionSnapshot,
        permissionRequests: terminal ? [] : previous.permissionRequests,
        contextUsage: terminal ? null : previous.contextUsage,
        isSending: !terminal && event.run.status !== "waiting_permission",
      }))

      if (terminal) {
        void refresh({
          workspaceRoot: activeWorkspaceRoot,
          sessionId: activeSessionId,
          preserveTranscript: true,
        })
      }
      return
    }

    if ((event.type === "permission.requested" || event.type === "permission.updated") && event.permissionRequest.sessionId === activeSessionId) {
      setState((previous) => ({
        ...previous,
        permissionRequests: upsertPermissionRequest(previous.permissionRequests, event.permissionRequest),
        isSending: false,
      }))
      return
    }

    if (event.type === "runtime.error" && event.sessionId === activeSessionId) {
      setState((previous) => ({
        ...previous,
        actionError: event.error,
        isSending: false,
      }))
    }

    if (event.type === "context.usage.updated" && event.sessionId === activeSessionId) {
      setState((previous) => ({
        ...previous,
        contextUsage: {
          contextTokens: event.contextTokens,
          contextWindow: event.contextWindow,
          utilizationPercent: event.utilizationPercent,
          source: event.source,
        },
      }))
    }
  })

  useEffect(() => {
    if (!bridge.requestJson && !bridge.apiOrigin) {
      return
    }

    void refresh()

    const unsubscribe = subscribeToEvents({
      onEvent(event) {
        handleEvent(event)
      },
      onOpen() {
        setState((previous) => ({
          ...previous,
          connection: {
            state: "online",
            label: "Connected to app-server",
            detail: bridge.apiOrigin ?? previous.activeWorkspaceRoot ?? "Desktop bridge",
          },
        }))
      },
      onError() {
        setState((previous) => ({
          ...previous,
          connection: {
            state: "offline",
            label: "Disconnected from app-server",
            detail: bridge.apiOrigin ?? previous.activeWorkspaceRoot ?? "Desktop bridge",
          },
          hasAuthoritativeWorkspaceBusyState: false,
        }))
      },
    })

    return unsubscribe
  }, [bridge.apiOrigin, bridge.requestJson])

  const actions = {
    async selectWorkspace(workspaceRoot: string) {
      setSelectionRef({
        activeWorkspaceRoot: workspaceRoot,
        activeSessionId: null,
      })
      setState((previous) => ({
        ...previous,
        activeWorkspaceRoot: workspaceRoot,
        skills: [],
        skillWarningMessage: null,
        activeSessionId: null,
        sessions: [],
        sessionRuns: [],
        transcript: [],
        permissionRequests: [],
        sessionSnapshot: null,
        contextUsage: null,
      }))

      await refresh({
        workspaceRoot,
        sessionId: null,
      })
    },

    async selectSession(sessionId: string) {
      setSelectionRef({
        activeWorkspaceRoot: selectionRef.current.activeWorkspaceRoot,
        activeSessionId: sessionId,
      })
      setState((previous) => ({
        ...previous,
        activeSessionId: sessionId,
        sessionRuns: [],
        contextUsage: null,
      }))

      await refresh({
        workspaceRoot: selectionRef.current.activeWorkspaceRoot,
        sessionId,
      })
    },

    async createEmptySession() {
      const workspaceRoot = resolveWorkspaceRoot({
        activeWorkspaceRoot: selectionRef.current.activeWorkspaceRoot,
        workspaces: state.workspaces,
      })

      if (!workspaceRoot) {
        setState((previous) => ({
          ...previous,
          actionError: "No workspace root is available for this desktop session.",
        }))
        return false
      }

      try {
        const created = await createSession({
          workspaceRoot,
        })

        setSelectionRef({
          activeWorkspaceRoot: workspaceRoot,
          activeSessionId: created.session.id,
        })
        setState((previous) => ({
          ...previous,
          sessions: upsertSession(previous.sessions, created.session),
          activeWorkspaceRoot: workspaceRoot,
          activeSessionId: created.session.id,
          sessionSnapshot: {
            session: created.session,
            latestRun: null,
            activeRun: null,
            status: "idle",
          },
          sessionRuns: [],
          transcript: [],
          permissionRequests: [],
          actionError: null,
        }))

        await refresh({
          workspaceRoot,
          sessionId: created.session.id,
        })

        return true
      } catch (error) {
        setState((previous) => ({
          ...previous,
          actionError: toErrorMessage(error),
        }))
        return false
      }
    },

    async createWorkspaceFromDialog() {
      setState((previous) => ({
        ...previous,
        isManagingWorkspace: true,
        actionError: null,
      }))

      try {
        const directory = await pickDirectory()
        if (!directory) {
          setState((previous) => ({
            ...previous,
            isManagingWorkspace: false,
          }))
          return false
        }

        const opened = await openWorkspace({
          directory,
          create: true,
        })
        knownWorkspacesRef.current.set(opened.workspace.workspaceRoot, opened.workspace)

        await refresh({
          workspaceRoot: opened.workspace.workspaceRoot,
          sessionId: null,
        })

        return true
      } catch (error) {
        setState((previous) => ({
          ...previous,
          isManagingWorkspace: false,
          actionError: toErrorMessage(error),
        }))
        return false
      }
    },

    async sendMessage(prompt: string) {
      const trimmedPrompt = prompt.trim()
      if (!trimmedPrompt || state.isSending) {
        return false
      }

      const workspaceRoot = resolveWorkspaceRoot({
        activeWorkspaceRoot: selectionRef.current.activeWorkspaceRoot,
        workspaces: state.workspaces,
      })
      if (!workspaceRoot) {
        setState((previous) => ({
          ...previous,
          actionError: "No workspace root is available for this desktop session.",
        }))
        return false
      }

      setState((previous) => ({
        ...previous,
        isSending: true,
        actionError: null,
      }))

      try {
        let sessionId = selectionRef.current.activeSessionId

        if (!sessionId) {
          const created = await createSession({
            workspaceRoot,
            title: summarizePrompt(trimmedPrompt),
          })

          sessionId = created.session.id

          setSelectionRef({
            activeWorkspaceRoot: workspaceRoot,
            activeSessionId: created.session.id,
          })
          setState((previous) => ({
            ...previous,
            sessions: upsertSession(previous.sessions, created.session),
            activeWorkspaceRoot: workspaceRoot,
            activeSessionId: created.session.id,
          }))
        }

        await startRun({
          sessionId,
          prompt: trimmedPrompt,
        })

        await refresh({
          workspaceRoot,
          sessionId,
          preserveTranscript: true,
        })
        return true
      } catch (error) {
        setState((previous) => ({
          ...previous,
          isSending: false,
          actionError: toErrorMessage(error),
        }))
        return false
      }
    },

    async cancelRun() {
      const runId = state.sessionSnapshot?.activeRun?.id
      if (!runId) {
        return
      }

      try {
        await cancelRun(runId)
        await refresh({
          workspaceRoot: selectionRef.current.activeWorkspaceRoot,
          sessionId: selectionRef.current.activeSessionId,
          preserveTranscript: true,
        })
      } catch (error) {
        setState((previous) => ({
          ...previous,
          actionError: toErrorMessage(error),
        }))
      }
    },

    async replyPermission(requestId: string, decision: "allow" | "deny") {
      try {
        await replyPermission({
          requestId,
          decision,
        })

        await refresh({
          workspaceRoot: selectionRef.current.activeWorkspaceRoot,
          sessionId: selectionRef.current.activeSessionId,
          preserveTranscript: true,
        })
        return true
      } catch (error) {
        setState((previous) => ({
          ...previous,
          actionError: toErrorMessage(error),
        }))
        return false
      }
    },

    async setSessionActiveSkills(sessionId: string, activeSkills: string[]) {
      try {
        const updated = await updateSessionActiveSkills({
          sessionId,
          activeSkills,
        })

        setState((previous) => ({
          ...previous,
          sessions:
            previous.activeWorkspaceRoot === updated.session.workspaceRoot
              ? upsertSession(previous.sessions, updated.session)
              : previous.sessions,
          sessionSnapshot:
            previous.activeSessionId === updated.session.id && previous.sessionSnapshot
              ? {
                  ...previous.sessionSnapshot,
                  session: updated.session,
                }
              : previous.sessionSnapshot,
          actionError: null,
        }))

        await refresh({
          workspaceRoot: selectionRef.current.activeWorkspaceRoot,
          sessionId: selectionRef.current.activeSessionId,
          preserveTranscript: true,
        })
      } catch (error) {
        setState((previous) => ({
          ...previous,
          actionError: toErrorMessage(error),
        }))
        throw error
      }
    },

    async deleteSession(sessionId: string) {
      const nextActiveSessionId =
        selectionRef.current.activeSessionId === sessionId
          ? pickNextSessionIdAfterDelete(state.sessions, sessionId)
          : selectionRef.current.activeSessionId

      try {
        await deleteSessionRequest(sessionId)

        if (selectionRef.current.activeSessionId === sessionId) {
          setSelectionRef({
            activeWorkspaceRoot: selectionRef.current.activeWorkspaceRoot,
            activeSessionId: nextActiveSessionId,
          })
        }
        setState((previous) => {
          const deletingActiveSession = previous.activeSessionId === sessionId

          return {
            ...previous,
            sessions: previous.sessions.filter((candidate) => candidate.id !== sessionId),
            activeSessionId: deletingActiveSession ? nextActiveSessionId : previous.activeSessionId,
            sessionSnapshot: deletingActiveSession ? null : previous.sessionSnapshot,
            sessionRuns: deletingActiveSession ? [] : previous.sessionRuns,
            transcript: deletingActiveSession ? [] : previous.transcript,
            permissionRequests: deletingActiveSession ? [] : previous.permissionRequests,
            isSending: deletingActiveSession ? false : previous.isSending,
            actionError: null,
          }
        })

        await refresh({
          workspaceRoot: selectionRef.current.activeWorkspaceRoot,
          sessionId: nextActiveSessionId,
        })

        return true
      } catch (error) {
        setState((previous) => ({
          ...previous,
          actionError: toErrorMessage(error),
        }))
        return false
      }
    },
    async refreshAppState() {
      await refresh({
        workspaceRoot: selectionRef.current.activeWorkspaceRoot,
        sessionId: selectionRef.current.activeSessionId,
      })
    },
  }

  return {
    bridge,
    ...state,
    ...actions,
  }
}

function createInitialState(input: {
  defaultWorkspaceRoot?: string | null
  persistedWorkspaceRoot?: string | null
  persistedSessionId?: string | null
}): AppState {
  const workspaces = createInitialWorkspaces(input)
  const activeWorkspaceRoot = input.persistedWorkspaceRoot ?? input.defaultWorkspaceRoot ?? null
  const activeSessionId = input.persistedSessionId ?? null

  if (!window.neoCoworkerDesktop?.requestJson && !window.neoCoworkerDesktop?.apiOrigin) {
    return {
      workspaces,
      skills: [],
      sessions: [],
      activeWorkspaceRoot,
      activeSessionId,
      sessionSnapshot: null,
      sessionRuns: [],
      transcript: [],
      permissionRequests: [],
      connection: {
        state: "error",
        label: "Desktop bridge unavailable",
        detail: "Connect this renderer to app-server through the desktop shell.",
      },
      hasAuthoritativeWorkspaceBusyState: false,
      isLoading: false,
      isSending: false,
      isManagingWorkspace: false,
      actionError: null,
      skillWarningMessage: null,
      contextUsage: null,
    }
  }

  return {
    workspaces,
    skills: [],
    sessions: [],
    activeWorkspaceRoot,
    activeSessionId,
    sessionSnapshot: null,
    sessionRuns: [],
    transcript: [],
    permissionRequests: [],
    connection: {
      state: "connecting",
      label: "Connecting to app-server",
      detail: window.neoCoworkerDesktop?.apiOrigin ?? activeWorkspaceRoot ?? "Desktop bridge",
    },
    hasAuthoritativeWorkspaceBusyState: false,
    isLoading: true,
    isSending: false,
    isManagingWorkspace: false,
    actionError: null,
    skillWarningMessage: null,
    contextUsage: null,
  }
}

function createInitialWorkspaces(input: {
  defaultWorkspaceRoot?: string | null
  persistedWorkspaceRoot?: string | null
}) {
  return [...createKnownWorkspacesMap(input).values()]
}

function createKnownWorkspacesMap(input: {
  defaultWorkspaceRoot?: string | null
  persistedWorkspaceRoot?: string | null
}) {
  const workspaces = new Map<string, DesktopWorkspaceSummary>()

  for (const workspaceRoot of [input.defaultWorkspaceRoot, input.persistedWorkspaceRoot]) {
    if (!workspaceRoot) {
      continue
    }

    const workspace = createDefaultWorkspace(workspaceRoot)
    workspaces.set(workspace.workspaceRoot, workspace)
  }

  return workspaces
}

function createDefaultWorkspace(workspaceRoot: string): DesktopWorkspaceSummary {
  return {
    workspaceRoot,
    name: workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceRoot,
    latestActivityAt: 0,
    sessionCount: 0,
    hasBusySession: false,
    sessions: [],
  }
}

function resolveWorkspaceRoot(input: {
  activeWorkspaceRoot: string | null
  workspaces: DesktopWorkspaceSummary[]
}) {
  if (input.activeWorkspaceRoot) {
    const activeWorkspace = input.workspaces.find(
      (workspace) => workspace.workspaceRoot === input.activeWorkspaceRoot,
    )
    if (activeWorkspace) {
      return activeWorkspace.workspaceRoot
    }
  }

  return input.workspaces[0]?.workspaceRoot ?? null
}

export function pickNextSessionIdAfterDelete(
  sessions: DesktopSessionSummary[],
  deletedSessionId: string,
) {
  return sessions.find((candidate) => candidate.id !== deletedSessionId)?.id ?? null
}

function upsertSession(
  sessions: DesktopSessionSummary[],
  session: DesktopSessionSummary,
) {
  const withoutCurrent = sessions.filter((candidate) => candidate.id !== session.id)
  withoutCurrent.push(session)
  return withoutCurrent.sort((left, right) => right.updatedAt - left.updatedAt)
}

function upsertPermissionRequest(
  requests: DesktopPermissionRequest[],
  request: DesktopPermissionRequest,
) {
  const pending = requests.filter((candidate) => candidate.id !== request.id)
  if (request.status === "pending") {
    pending.push(request)
  }
  return pending.sort((left, right) => left.createdAt - right.createdAt)
}

function upsertSessionRun(runs: DesktopRun[], run: DesktopRun) {
  const withoutCurrent = runs.filter((candidate) => candidate.id !== run.id)
  withoutCurrent.push(run)
  return withoutCurrent.sort((left, right) => left.createdAt - right.createdAt)
}

function summarizePrompt(prompt: string) {
  const compact = prompt.replace(/\s+/g, " ").trim()
  if (!compact) {
    return "New session"
  }

  if (compact.length <= 60) {
    return compact
  }

  return `${compact.slice(0, 57).trimEnd()}...`
}

function isTerminalRunStatus(status: DesktopRun["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
