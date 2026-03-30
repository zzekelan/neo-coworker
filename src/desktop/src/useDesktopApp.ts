import { useEffect, useEffectEvent, useRef, useState } from "react"
import {
  cancelRun,
  createSession,
  getDesktopBridge,
  loadWorkspaces,
  loadWorkspaceSkills,
  loadRun,
  loadSession,
  loadWorkspaceSessions,
  loadTranscript,
  openWorkspace,
  pickDirectory,
  persistDesktopSelection,
  replyPermission,
  startRun,
  subscribeToEvents,
  updateRunActiveSkills,
  updateSessionActiveSkills,
} from "./api"
import {
  normalizeTranscript,
  upsertTranscriptMessage,
  upsertTranscriptMessagePart,
} from "./transcript-state"
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
  transcript: DesktopMessage[]
  permissionRequests: DesktopPermissionRequest[]
  connection: ConnectionStatus
  isLoading: boolean
  isSending: boolean
  isManagingWorkspace: boolean
  actionError: string | null
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

  useEffect(() => {
    selectionRef.current = {
      activeWorkspaceRoot: state.activeWorkspaceRoot,
      activeSessionId: state.activeSessionId,
    }
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
      const workspaceData = await loadWorkspaces()
      const workspaces = mergeWorkspaces(workspaceData.workspaces, knownWorkspacesRef.current)
      const requestedWorkspaceRoot =
        options.workspaceRoot ?? selectionRef.current.activeWorkspaceRoot ?? bridge.defaultWorkspaceRoot ?? null
      const resolvedWorkspaceRoot =
        requestedWorkspaceRoot &&
        workspaces.some((workspace) => workspace.workspaceRoot === requestedWorkspaceRoot)
          ? requestedWorkspaceRoot
          : workspaces[0]?.workspaceRoot ?? null
      const sessionData = resolvedWorkspaceRoot
        ? await loadWorkspaceSessions(resolvedWorkspaceRoot)
        : { sessions: [] }
      const skillData = resolvedWorkspaceRoot
        ? await loadWorkspaceSkills(resolvedWorkspaceRoot)
        : { skills: [] }
      const activeSessionId = chooseActiveSessionId({
        preferredSessionId: options.sessionId ?? selectionRef.current.activeSessionId,
        sessions: sessionData.sessions,
      })

      let snapshot: DesktopSessionSnapshot | null = null
      let transcript: DesktopMessage[] = []
      let permissionRequests: DesktopPermissionRequest[] = []
      let sessionRestoreError: unknown = null

      if (activeSessionId) {
        try {
          snapshot = await loadSession(activeSessionId)
          const transcriptData = await loadTranscript(activeSessionId)
          transcript = normalizeTranscript(transcriptData.transcript)

          if (snapshot.activeRun) {
            const runState = await loadRun(snapshot.activeRun.id)
            permissionRequests = runState.permissionRequests
              .filter((request) => request.status === "pending")
              .sort((left, right) => left.createdAt - right.createdAt)
          }
        } catch (error) {
          sessionRestoreError = error
        }
      }

      if (currentToken !== refreshTokenRef.current) {
        return
      }

      setState((previous) => ({
        ...previous,
        workspaces,
        skills: skillData.skills,
        sessions: sessionData.sessions,
        activeWorkspaceRoot: resolvedWorkspaceRoot,
        activeSessionId,
        sessionSnapshot: snapshot,
        transcript,
        permissionRequests,
        connection: {
          state: "online",
          label: "Connected to app-server",
          detail: bridge.apiOrigin ?? resolvedWorkspaceRoot ?? "Desktop bridge",
        },
        isLoading: false,
        isSending:
          snapshot?.activeRun !== null &&
          snapshot?.activeRun !== undefined &&
          snapshot.activeRun.status !== "waiting_permission",
        isManagingWorkspace: false,
        actionError: sessionRestoreError ? toErrorMessage(sessionRestoreError) : null,
      }))
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
        connection: {
          state: "error",
          label: "app-server unavailable",
          detail: bridge.apiOrigin ?? bridge.defaultWorkspaceRoot ?? "Desktop bridge",
        },
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
        sessionSnapshot: previous.sessionSnapshot
          ? {
              ...previous.sessionSnapshot,
              latestRun: event.run,
              activeRun: terminal ? null : event.run,
              status: terminal ? "idle" : "busy",
            }
          : previous.sessionSnapshot,
        permissionRequests: terminal ? [] : previous.permissionRequests,
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
        }))
      },
    })

    return unsubscribe
  }, [bridge.apiOrigin, bridge.requestJson])

  const actions = {
    async selectWorkspace(workspaceRoot: string) {
      setState((previous) => ({
        ...previous,
        activeWorkspaceRoot: workspaceRoot,
        skills: [],
        activeSessionId: null,
        sessions: [],
        transcript: [],
        permissionRequests: [],
        sessionSnapshot: null,
      }))

      await refresh({
        workspaceRoot,
        sessionId: null,
      })
    },

    async selectSession(sessionId: string) {
      setState((previous) => ({
        ...previous,
        activeSessionId: sessionId,
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
      } catch (error) {
        setState((previous) => ({
          ...previous,
          actionError: toErrorMessage(error),
        }))
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
          sessions: upsertSession(previous.sessions, updated.session),
          sessionSnapshot:
            previous.sessionSnapshot?.session.id === updated.session.id
              ? {
                  ...previous.sessionSnapshot,
                  session: updated.session,
                }
              : previous.sessionSnapshot,
          actionError: null,
        }))

        await refresh({
          workspaceRoot: selectionRef.current.activeWorkspaceRoot,
          sessionId: updated.session.id,
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

    async setRunActiveSkills(runId: string, activeSkills: string[]) {
      try {
        await updateRunActiveSkills({
          runId,
          activeSkills,
        })

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
      transcript: [],
      permissionRequests: [],
      connection: {
        state: "error",
        label: "Desktop bridge unavailable",
        detail: "Connect this renderer to app-server through the desktop shell.",
      },
      isLoading: false,
      isSending: false,
      isManagingWorkspace: false,
      actionError: null,
    }
  }

  return {
    workspaces,
    skills: [],
    sessions: [],
    activeWorkspaceRoot,
    activeSessionId,
    sessionSnapshot: null,
    transcript: [],
    permissionRequests: [],
    connection: {
      state: "connecting",
      label: "Connecting to app-server",
      detail: window.neoCoworkerDesktop?.apiOrigin ?? activeWorkspaceRoot ?? "Desktop bridge",
    },
    isLoading: true,
    isSending: false,
    isManagingWorkspace: false,
    actionError: null,
  }
}

function chooseActiveSessionId(input: {
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
    sessions: [],
  }
}

function mergeWorkspaces(
  workspaces: DesktopWorkspaceSummary[],
  knownWorkspaces: ReadonlyMap<string, DesktopWorkspaceSummary>,
) {
  const merged = new Map(knownWorkspaces)

  for (const workspace of workspaces) {
    merged.set(workspace.workspaceRoot, workspace)
  }

  return [...merged.values()].sort((left, right) => right.latestActivityAt - left.latestActivityAt)
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
