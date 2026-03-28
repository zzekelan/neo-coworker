import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react"
import {
  cancelRun,
  createThread,
  getDesktopBridge,
  loadProjects,
  loadRun,
  loadSession,
  loadThreads,
  loadTranscript,
  replyPermission,
  startRun,
  subscribeToEvents,
} from "./api"
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
  const [state, setState] = useState<AppState>(() => createInitialState(bridge.defaultWorkspaceRoot))
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
      const requestedProjectRoot =
        options.projectRoot ?? selectionRef.current.activeProjectRoot ?? bridge.defaultWorkspaceRoot ?? null
      const resolvedProjectRoot =
        requestedProjectRoot ?? projectData.projects[0]?.workspaceRoot ?? null
      const threadData = resolvedProjectRoot ? await loadThreads(resolvedProjectRoot) : { threads: [] }
      const activeSessionId = chooseActiveSessionId({
        preferredSessionId: options.sessionId ?? selectionRef.current.activeSessionId,
        threads: threadData.threads,
      })

      let snapshot: DesktopSessionSnapshot | null = null
      let transcript: DesktopMessage[] = []
      let permissionRequests: DesktopPermissionRequest[] = []

      if (activeSessionId) {
        snapshot = await loadSession(activeSessionId)
        const transcriptData = await loadTranscript(activeSessionId)
        transcript = sortTranscript(transcriptData.transcript)

        if (snapshot.activeRun) {
          const runState = await loadRun(snapshot.activeRun.id)
          permissionRequests = runState.permissionRequests
            .filter((request) => request.status === "pending")
            .sort((left, right) => left.createdAt - right.createdAt)
        }
      }

      if (currentToken !== refreshTokenRef.current) {
        return
      }

      startTransition(() => {
        setState((previous) => ({
          ...previous,
          projects: projectData.projects,
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
          actionError: null,
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
        transcript: upsertMessage(previous.transcript, {
          ...event.message,
          parts: [],
        }),
      }))
      return
    }

    if (event.type === "message.part.updated" && event.part.sessionId === activeSessionId) {
      setState((previous) => ({
        ...previous,
        transcript: upsertMessagePart(previous.transcript, event.part),
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
  }, [bridge.apiOrigin, bridge.requestJson, handleEvent, refresh])

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
      const workspaceRoot =
        selectionRef.current.activeProjectRoot ?? bridge.defaultWorkspaceRoot ?? state.projects[0]?.workspaceRoot ?? null

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

    async sendMessage(prompt: string) {
      const trimmedPrompt = prompt.trim()
      if (!trimmedPrompt || state.isSending) {
        return false
      }

      const workspaceRoot =
        selectionRef.current.activeProjectRoot ?? bridge.defaultWorkspaceRoot ?? state.projects[0]?.workspaceRoot ?? null
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

function createInitialState(defaultWorkspaceRoot?: string | null): AppState {
  if (!window.neoCoworkerDesktop?.requestJson && !window.neoCoworkerDesktop?.apiOrigin) {
    return {
      projects: [],
      threads: [],
      activeProjectRoot: defaultWorkspaceRoot ?? null,
      activeSessionId: null,
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
      actionError: null,
    }
  }

  return {
    projects: [],
    threads: [],
    activeProjectRoot: defaultWorkspaceRoot ?? null,
    activeSessionId: null,
    sessionSnapshot: null,
    transcript: [],
    permissionRequests: [],
    connection: {
      state: "connecting",
      label: "Connecting to app-server",
      detail: window.neoCoworkerDesktop?.apiOrigin ?? defaultWorkspaceRoot ?? "Desktop bridge",
    },
    isLoading: true,
    isSending: false,
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

function sortTranscript(messages: DesktopMessage[]) {
  return messages
    .map((message) => ({
      ...message,
      parts: message.parts
        .slice()
        .sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt),
    }))
    .sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt)
}

function upsertThread(threads: DesktopThread[], thread: DesktopThread) {
  const withoutCurrent = threads.filter((candidate) => candidate.id !== thread.id)
  withoutCurrent.push(thread)
  return withoutCurrent.sort((left, right) => right.updatedAt - left.updatedAt)
}

function upsertMessage(messages: DesktopMessage[], message: DesktopMessage) {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index === -1) {
    return sortTranscript([...messages, message])
  }

  const next = messages.slice()
  next[index] = {
    ...next[index],
    ...message,
    parts: sortParts(message.parts.length > 0 ? message.parts : next[index].parts),
  }
  return sortTranscript(next)
}

function upsertMessagePart(messages: DesktopMessage[], part: DesktopMessage["parts"][number]) {
  const messageIndex = messages.findIndex((message) => message.id === part.messageId)
  if (messageIndex === -1) {
    return messages
  }

  const next = messages.slice()
  const target = next[messageIndex]
  const partIndex = target.parts.findIndex((candidate) => candidate.id === part.id)
  const parts = target.parts.slice()

  if (partIndex === -1) {
    parts.push(part)
  } else {
    parts[partIndex] = part
  }

  next[messageIndex] = {
    ...target,
    parts: sortParts(parts),
  }
  return sortTranscript(next)
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

function sortParts(parts: DesktopMessage["parts"]) {
  return parts
    .slice()
    .sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt)
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
