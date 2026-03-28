import { useEffect, useEffectEvent, useRef, useState } from "react"
import {
  cancelRun,
  createThread,
  getDesktopBridge,
  loadProjects,
  loadRun,
  loadSession,
  loadThreads,
  loadTranscript,
  openWorkspace,
  pickDirectory,
  persistDesktopSelection,
  replyPermission,
  startRun,
  subscribeToEvents,
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
  DesktopProject,
  DesktopRun,
  DesktopServerEvent,
  DesktopSessionSnapshot,
  DesktopThread,
} from "./types"

type AppState = {
  projects: DesktopProject[]
  threads: DesktopThread[]
  activeProjectRoot: string | null
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
  projectRoot?: string | null
  sessionId?: string | null
  preserveTranscript?: boolean
}

export function useDesktopApp() {
  const bridgeRef = useRef(getDesktopBridge())
  const bridge = bridgeRef.current
  const [state, setState] = useState<AppState>(() =>
    createInitialState({
      defaultWorkspaceRoot: bridge.defaultWorkspaceRoot,
      persistedProjectRoot: bridge.persistedProjectRoot,
      persistedSessionId: bridge.persistedSessionId,
    }),
  )
  const knownProjectsRef = useRef(createKnownProjectsMap({
    defaultWorkspaceRoot: bridge.defaultWorkspaceRoot,
    persistedProjectRoot: bridge.persistedProjectRoot,
  }))
  const selectionRef = useRef({
    activeProjectRoot: state.activeProjectRoot,
    activeSessionId: state.activeSessionId,
  })
  const refreshTokenRef = useRef(0)

  useEffect(() => {
    selectionRef.current = {
      activeProjectRoot: state.activeProjectRoot,
      activeSessionId: state.activeSessionId,
    }
  }, [state.activeProjectRoot, state.activeSessionId])

  useEffect(() => {
    void persistDesktopSelection({
      activeProjectRoot: state.activeProjectRoot,
      activeSessionId: state.activeSessionId,
    }).catch(() => {})
  }, [state.activeProjectRoot, state.activeSessionId])

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
      const projectData = await loadProjects()
      const projects = mergeProjects(projectData.projects, knownProjectsRef.current)
      const requestedProjectRoot =
        options.projectRoot ?? selectionRef.current.activeProjectRoot ?? bridge.defaultWorkspaceRoot ?? null
      const resolvedProjectRoot =
        requestedProjectRoot && projects.some((project) => project.workspaceRoot === requestedProjectRoot)
          ? requestedProjectRoot
          : projects[0]?.workspaceRoot ?? null
      const threadData = resolvedProjectRoot ? await loadThreads(resolvedProjectRoot) : { threads: [] }
      const activeSessionId = chooseActiveSessionId({
        preferredSessionId: options.sessionId ?? selectionRef.current.activeSessionId,
        threads: threadData.threads,
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
        projects,
        threads: threadData.threads,
        activeProjectRoot: resolvedProjectRoot,
        activeSessionId,
        sessionSnapshot: snapshot,
        transcript,
        permissionRequests,
        connection: {
          state: "online",
          label: "Connected to app-server",
          detail: bridge.apiOrigin ?? resolvedProjectRoot ?? "Desktop bridge",
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
    const { activeProjectRoot, activeSessionId } = selectionRef.current

    if (event.type === "heartbeat") {
      setState((previous) => ({
        ...previous,
        connection: {
          state: "online",
          label: "Connected to app-server",
          detail: bridge.apiOrigin ?? previous.activeProjectRoot ?? "Desktop bridge",
        },
      }))
      return
    }

    if ((event.type === "session.created" || event.type === "session.updated") && event.session.workspaceRoot === activeProjectRoot) {
      setState((previous) => ({
        ...previous,
        threads: upsertThread(previous.threads, event.session),
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
          projectRoot: activeProjectRoot,
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
            detail: bridge.apiOrigin ?? previous.activeProjectRoot ?? "Desktop bridge",
          },
        }))
      },
      onError() {
        setState((previous) => ({
          ...previous,
          connection: {
            state: "offline",
            label: "Disconnected from app-server",
            detail: bridge.apiOrigin ?? previous.activeProjectRoot ?? "Desktop bridge",
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
        activeProjectRoot: workspaceRoot,
        activeSessionId: null,
        threads: [],
        transcript: [],
        permissionRequests: [],
        sessionSnapshot: null,
      }))

      await refresh({
        projectRoot: workspaceRoot,
        sessionId: null,
      })
    },

    async selectSession(sessionId: string) {
      setState((previous) => ({
        ...previous,
        activeSessionId: sessionId,
      }))

      await refresh({
        projectRoot: selectionRef.current.activeProjectRoot,
        sessionId,
      })
    },

    async createEmptyThread() {
      const workspaceRoot = resolveWorkspaceRoot({
        activeProjectRoot: selectionRef.current.activeProjectRoot,
        projects: state.projects,
      })

      if (!workspaceRoot) {
        setState((previous) => ({
          ...previous,
          actionError: "No workspace root is available for this desktop session.",
        }))
        return false
      }

      try {
        const created = await createThread({
          workspaceRoot,
        })

        setState((previous) => ({
          ...previous,
          threads: upsertThread(previous.threads, created.thread),
          activeProjectRoot: workspaceRoot,
          activeSessionId: created.thread.id,
          sessionSnapshot: {
            session: created.thread,
            latestRun: null,
            activeRun: null,
            status: "idle",
          },
          transcript: [],
          permissionRequests: [],
          actionError: null,
        }))

        await refresh({
          projectRoot: workspaceRoot,
          sessionId: created.thread.id,
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
        knownProjectsRef.current.set(opened.project.workspaceRoot, opened.project)

        await refresh({
          projectRoot: opened.project.workspaceRoot,
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
        activeProjectRoot: selectionRef.current.activeProjectRoot,
        projects: state.projects,
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
          const created = await createThread({
            workspaceRoot,
            title: summarizePrompt(trimmedPrompt),
          })

          sessionId = created.thread.id

          setState((previous) => ({
            ...previous,
            threads: upsertThread(previous.threads, created.thread),
            activeProjectRoot: workspaceRoot,
            activeSessionId: created.thread.id,
          }))
        }

        await startRun({
          sessionId,
          prompt: trimmedPrompt,
        })

        await refresh({
          projectRoot: workspaceRoot,
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
          projectRoot: selectionRef.current.activeProjectRoot,
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
          projectRoot: selectionRef.current.activeProjectRoot,
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
  }

  return {
    bridge,
    ...state,
    ...actions,
  }
}

function createInitialState(input: {
  defaultWorkspaceRoot?: string | null
  persistedProjectRoot?: string | null
  persistedSessionId?: string | null
}): AppState {
  const projects = createInitialProjects(input)
  const activeProjectRoot = input.persistedProjectRoot ?? input.defaultWorkspaceRoot ?? null
  const activeSessionId = input.persistedSessionId ?? null

  if (!window.neoCoworkerDesktop?.requestJson && !window.neoCoworkerDesktop?.apiOrigin) {
    return {
      projects,
      threads: [],
      activeProjectRoot,
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
    projects,
    threads: [],
    activeProjectRoot,
    activeSessionId,
    sessionSnapshot: null,
    transcript: [],
    permissionRequests: [],
    connection: {
      state: "connecting",
      label: "Connecting to app-server",
      detail: window.neoCoworkerDesktop?.apiOrigin ?? activeProjectRoot ?? "Desktop bridge",
    },
    isLoading: true,
    isSending: false,
    isManagingWorkspace: false,
    actionError: null,
  }
}

function chooseActiveSessionId(input: {
  preferredSessionId: string | null | undefined
  threads: DesktopThread[]
}) {
  if (input.preferredSessionId && input.threads.some((thread) => thread.id === input.preferredSessionId)) {
    return input.preferredSessionId
  }

  return input.threads[0]?.id ?? null
}

function createInitialProjects(input: {
  defaultWorkspaceRoot?: string | null
  persistedProjectRoot?: string | null
}) {
  return [...createKnownProjectsMap(input).values()]
}

function createKnownProjectsMap(input: {
  defaultWorkspaceRoot?: string | null
  persistedProjectRoot?: string | null
}) {
  const projects = new Map<string, DesktopProject>()

  for (const workspaceRoot of [input.defaultWorkspaceRoot, input.persistedProjectRoot]) {
    if (!workspaceRoot) {
      continue
    }

    const project = createDefaultProject(workspaceRoot)
    projects.set(project.workspaceRoot, project)
  }

  return projects
}

function createDefaultProject(workspaceRoot: string): DesktopProject {
  return {
    workspaceRoot,
    name: workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceRoot,
    latestActivityAt: 0,
    threadCount: 0,
    pendingCandidateCount: 0,
    assetCounts: {
      source: 0,
      note: 0,
      finding: 0,
      artifact: 0,
    },
    threads: [],
  }
}

function mergeProjects(
  projects: DesktopProject[],
  knownProjects: ReadonlyMap<string, DesktopProject>,
) {
  const merged = new Map(knownProjects)

  for (const project of projects) {
    merged.set(project.workspaceRoot, project)
  }

  return [...merged.values()].sort((left, right) => right.latestActivityAt - left.latestActivityAt)
}

function resolveWorkspaceRoot(input: {
  activeProjectRoot: string | null
  projects: DesktopProject[]
}) {
  if (input.activeProjectRoot) {
    const activeProject = input.projects.find(
      (project) => project.workspaceRoot === input.activeProjectRoot,
    )
    if (activeProject) {
      return activeProject.workspaceRoot
    }
  }

  return input.projects[0]?.workspaceRoot ?? null
}

function upsertThread(threads: DesktopThread[], thread: DesktopThread) {
  const withoutCurrent = threads.filter((candidate) => candidate.id !== thread.id)
  withoutCurrent.push(thread)
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
    return "New thread"
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
