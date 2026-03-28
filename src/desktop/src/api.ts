import type {
  DesktopPermissionRequest,
  DesktopProject,
  DesktopRun,
  DesktopServerEvent,
  DesktopSessionSnapshot,
  DesktopThread,
  DesktopMessage,
} from "./types"

const SERVER_EVENT_TYPES = [
  "heartbeat",
  "session.created",
  "session.updated",
  "run.created",
  "run.updated",
  "message.created",
  "message.part.updated",
  "permission.requested",
  "permission.updated",
  "runtime.error",
] as const

type JsonRequestInput = {
  path: string
  method?: string
  body?: unknown
}

type RequestOptions = Omit<JsonRequestInput, "path">

type JsonEnvelope<T> = {
  data: T
}

export function getDesktopBridge() {
  return window.neoCoworkerDesktop ?? {}
}

export async function pickDirectory() {
  const bridge = getDesktopBridge()
  return bridge.pickDirectory ? bridge.pickDirectory() : null
}

export async function persistDesktopSelection(input: {
  activeProjectRoot: string | null
  activeSessionId: string | null
}) {
  const bridge = getDesktopBridge()
  if (!bridge.persistSelection) {
    return false
  }

  return bridge.persistSelection(input)
}

export async function requestApi<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const bridge = getDesktopBridge()

  if (bridge.requestJson) {
    const response = await bridge.requestJson({
      path,
      method: options.method,
      body: options.body,
    })

    if (!response.ok) {
      throw new Error(extractErrorMessage(response.body, response.status, options.method, path))
    }

    return unwrapEnvelope<T>(response.body)
  }

  if (!bridge.apiOrigin) {
    throw new Error("Desktop bridge is unavailable. app-server cannot be reached.")
  }

  const response = await fetch(new URL(path, bridge.apiOrigin), {
    method: options.method,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  const body = await response.json()
  if (!response.ok) {
    throw new Error(extractErrorMessage(body, response.status, options.method, path))
  }

  return unwrapEnvelope<T>(body)
}

export function subscribeToEvents(input: {
  onEvent(event: DesktopServerEvent): void
  onOpen?(): void
  onError?(): void
}) {
  const bridge = getDesktopBridge()

  if (bridge.apiOrigin) {
    const source = new EventSource(new URL("/events", bridge.apiOrigin))

    const handleEvent = (rawEvent: Event) => {
      const event = rawEvent as MessageEvent<string>
      input.onEvent(JSON.parse(event.data) as DesktopServerEvent)
    }

    for (const eventType of SERVER_EVENT_TYPES) {
      source.addEventListener(eventType, handleEvent as EventListener)
    }

    source.onopen = () => {
      input.onOpen?.()
    }

    source.onerror = () => {
      input.onError?.()
    }

    return () => {
      for (const eventType of SERVER_EVENT_TYPES) {
        source.removeEventListener(eventType, handleEvent as EventListener)
      }
      source.close()
    }
  }

  const handleWindowEvent = (event: Event) => {
    const customEvent = event as CustomEvent<DesktopServerEvent>
    input.onEvent(customEvent.detail)
  }

  const handleWindowError = () => {
    input.onError?.()
  }

  window.addEventListener("neo-coworker:event", handleWindowEvent)
  window.addEventListener("neo-coworker:event-error", handleWindowError)

  return () => {
    window.removeEventListener("neo-coworker:event", handleWindowEvent)
    window.removeEventListener("neo-coworker:event-error", handleWindowError)
  }
}

export async function loadProjects() {
  return requestApi<{ projects: DesktopProject[] }>("/projects")
}

export async function openWorkspace(input: { directory: string; create?: boolean }) {
  return requestApi<{ project: DesktopProject }>("/projects/open", {
    method: "POST",
    body: input,
  })
}

export async function loadThreads(workspaceRoot: string) {
  return requestApi<{ threads: DesktopThread[] }>(
    `/project/threads?workspaceRoot=${encodeURIComponent(workspaceRoot)}`,
  )
}

export async function createThread(input: { workspaceRoot: string; title?: string }) {
  return requestApi<{ thread: DesktopThread }>("/project/threads", {
    method: "POST",
    body: input,
  })
}

export async function loadSession(sessionId: string) {
  return requestApi<DesktopSessionSnapshot>(`/sessions/${encodeURIComponent(sessionId)}`)
}

export async function loadTranscript(sessionId: string) {
  return requestApi<{ transcript: DesktopMessage[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/transcript`,
  )
}

export async function startRun(input: { sessionId: string; prompt: string }) {
  return requestApi<{ run: DesktopRun; message: Omit<DesktopMessage, "parts"> }>(
    `/sessions/${encodeURIComponent(input.sessionId)}/runs`,
    {
      method: "POST",
      body: {
        prompt: input.prompt,
        trigger: "prompt",
      },
    },
  )
}

export async function loadRun(runId: string) {
  return requestApi<{ run: DesktopRun; permissionRequests: DesktopPermissionRequest[] }>(
    `/runs/${encodeURIComponent(runId)}`,
  )
}

export async function cancelRun(runId: string) {
  return requestApi<{ run: DesktopRun }>(`/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  })
}

export async function replyPermission(input: { requestId: string; decision: "allow" | "deny" }) {
  return requestApi<{ run: DesktopRun; permissionRequest: DesktopPermissionRequest }>(
    `/permissions/${encodeURIComponent(input.requestId)}/reply`,
    {
      method: "POST",
      body: {
        decision: input.decision,
      },
    },
  )
}

function unwrapEnvelope<T>(value: unknown): T {
  if (!value || typeof value !== "object" || !("data" in value)) {
    throw new Error("app-server returned an invalid response payload")
  }

  return (value as JsonEnvelope<T>).data
}

function extractErrorMessage(
  value: unknown,
  status: number,
  method = "GET",
  path = "",
) {
  if (value && typeof value === "object" && "error" in value) {
    const candidate = (value as { error?: { message?: string } }).error?.message
    if (candidate) {
      return candidate
    }
  }

  return `${method} ${path} failed with status ${status}`
}
