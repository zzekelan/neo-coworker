import {
  createServerApp,
  type CreateServerAppRuntime,
  type OrchestrationModelPort,
  type PermissionRepository,
  type SessionSnapshot,
  type SessionRepository as StorageRepository,
  type ServerEvent,
  type StoredMessage,
  type StoredPermissionRequest,
  type StoredRun,
  type StoredSession,
} from "../bootstrap"

type SendRequest = (request: Request) => Promise<Response> | Response

type JsonErrorBody = {
  error?: {
    code?: string
    message?: string
  }
}

type Subscription = {
  events: AsyncIterable<ServerEvent>
  close(): Promise<void>
}

export type AgentServerClient = {
  listSessions(): Promise<StoredSession[]>
  createSession(input: {
    directory: string
    workspaceRoot: string
  }): Promise<StoredSession>
  getSession(sessionId: string): Promise<SessionSnapshot>
  startRun(input: {
    sessionId: string
    prompt: string
    trigger?: StoredRun["trigger"]
  }): Promise<{
    run: StoredRun
    message: StoredMessage
  }>
  getRun(runId: string): Promise<{
    run: StoredRun
    permissionRequests: StoredPermissionRequest[]
  }>
  replyPermission(input: {
    requestId: string
    decision: "allow" | "deny"
  }): Promise<{
    run: StoredRun
    permissionRequest: StoredPermissionRequest
  }>
  cancelRun(runId: string): Promise<StoredRun>
  subscribe(): Promise<Subscription>
}

export type CliServerClientHandle = {
  client: AgentServerClient
  close(): Promise<void>
}

type LocalServerRuntime = ReturnType<CreateServerAppRuntime>

type LocalRuntimeFactory = (input: {
  provider: OrchestrationModelPort
  repository: StorageRepository
  permissionRepository: PermissionRepository
  now: () => number
}) => LocalServerRuntime

export class AgentServerClientError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(input: { status: number; code?: string | null; message: string }) {
    super(input.message)
    this.name = "AgentServerClientError"
    this.status = input.status
    this.code = input.code ?? null
  }
}

export function createAgentServerClient(input: {
  origin: string
  send?: SendRequest
  fetchImpl?: typeof fetch
}): AgentServerClient {
  const send =
    input.send ??
    ((request: Request) => {
      const fetchImpl = input.fetchImpl ?? fetch
      return fetchImpl(request)
    })

  function createRequest(path: string, init: RequestInit = {}) {
    return new Request(new URL(path, input.origin), init)
  }

  async function requestJson<T>(path: string, init: RequestInit = {}) {
    const response = await send(createRequest(path, init))
    const body = (await readJsonBody(response)) as
      | {
          data: T
        }
      | JsonErrorBody

    if (!response.ok) {
      const errorBody = body as JsonErrorBody
      throw new AgentServerClientError({
        status: response.status,
        code: errorBody.error?.code,
        message:
          errorBody.error?.message ??
          `${init.method ?? "GET"} ${path} failed with status ${response.status}`,
      })
    }

    return (body as { data: T }).data
  }

  return {
    listSessions() {
      return requestJson<{ sessions: StoredSession[] }>("/sessions").then((data) => data.sessions)
    },
    createSession(inputValue) {
      return requestJson<{ session: StoredSession }>("/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(inputValue),
      }).then((data) => data.session)
    },
    getSession(sessionId) {
      return requestJson<SessionSnapshot>(`/sessions/${encodeURIComponent(sessionId)}`)
    },
    startRun(inputValue) {
      return requestJson<{
        run: StoredRun
        message: StoredMessage
      }>(`/sessions/${encodeURIComponent(inputValue.sessionId)}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: inputValue.prompt,
          trigger: inputValue.trigger,
        }),
      })
    },
    getRun(runId) {
      return requestJson<{
        run: StoredRun
        permissionRequests: StoredPermissionRequest[]
      }>(`/runs/${encodeURIComponent(runId)}`)
    },
    replyPermission(inputValue) {
      return requestJson<{
        run: StoredRun
        permissionRequest: StoredPermissionRequest
      }>(`/permissions/${encodeURIComponent(inputValue.requestId)}/reply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          decision: inputValue.decision,
        }),
      })
    },
    cancelRun(runId) {
      return requestJson<{
        run: StoredRun
      }>(`/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      }).then((data) => data.run)
    },
    async subscribe() {
      const controller = new AbortController()
      const response = await send(
        createRequest("/events", {
          headers: {
            accept: "text/event-stream",
          },
          signal: controller.signal,
        }),
      )

      if (!response.ok) {
        const body = (await readJsonBody(response)) as JsonErrorBody
        throw new AgentServerClientError({
          status: response.status,
          code: body.error?.code,
          message: body.error?.message ?? `GET /events failed with status ${response.status}`,
        })
      }

      if (!response.body) {
        throw new Error("Server returned an empty SSE response body")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const queue = createEventQueue<ServerEvent>()
      let buffer = ""
      let closed = false
      let streamError: unknown = null

      const pump = (async () => {
        try {
          while (!closed) {
            const next = await reader.read()
            if (next.done) {
              return
            }

            buffer += decoder.decode(next.value, { stream: true })

            while (true) {
              const delimiterIndex = buffer.indexOf("\n\n")
              if (delimiterIndex === -1) {
                break
              }

              const block = buffer.slice(0, delimiterIndex)
              buffer = buffer.slice(delimiterIndex + 2)

              const event = parseSseBlock(block)
              if (!event) {
                continue
              }

              queue.push(event)
            }
          }
        } catch (error) {
          if (!closed) {
            streamError = error
          }
        } finally {
          queue.close()
        }
      })()

      return {
        events: (async function* () {
          for await (const event of queue.stream()) {
            yield event
          }

          if (streamError) {
            throw streamError
          }
        })(),
        async close() {
          if (closed) {
            return
          }

          closed = true
          controller.abort()

          try {
            await reader.cancel()
          } catch {
            // Ignore cancellation errors from already-closed streams.
          }

          await pump
        },
      }
    },
  }
}

export async function createLocalCliServerClient(input: {
  provider: OrchestrationModelPort
  repository: StorageRepository
  permissionRepository: PermissionRepository
  createRuntimeImpl: LocalRuntimeFactory
  closeImpl?: () => void | Promise<void>
}) {
  const app = createServerApp({
    createRuntimeImpl(serverInput) {
      return input.createRuntimeImpl({
        provider: input.provider,
        repository: serverInput.repository,
        permissionRepository: serverInput.permissionRepository,
        now: serverInput.now,
      })
    },
    repository: input.repository,
    permissionRepository: input.permissionRepository,
  })

  return {
    client: {
      async listSessions() {
        return app.sessions.list()
      },
      async createSession(sessionInput) {
        return app.sessions.create({
          directory: sessionInput.directory,
          workspaceRoot: sessionInput.workspaceRoot,
        })
      },
      async getSession(sessionId) {
        return app.sessions.get(sessionId)
      },
      async startRun(runInput) {
        return app.runs.start({
          sessionId: runInput.sessionId,
          prompt: runInput.prompt,
          trigger: runInput.trigger,
        })
      },
      async getRun(runId) {
        return app.runs.get(runId)
      },
      async replyPermission(reply) {
        return app.permissions.reply(reply)
      },
      async cancelRun(runId) {
        return app.runs.cancel(runId)
      },
      async subscribe() {
        const subscription = app.subscribe()
        return {
          events: subscription.events,
          async close() {
            subscription.unsubscribe()
          },
        } satisfies Subscription
      },
    } satisfies AgentServerClient,
    async close() {
      await app.close()
      await input.closeImpl?.()
    },
  } satisfies CliServerClientHandle
}

async function readJsonBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return {}
  }

  return response.json()
}

function parseSseBlock(block: string): ServerEvent | null {
  if (!block.trim()) {
    return null
  }

  const dataLines: string[] = []

  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim())
    }
  }

  if (dataLines.length === 0) {
    return null
  }

  return JSON.parse(dataLines.join("\n")) as ServerEvent
}

function createEventQueue<T>() {
  const items: T[] = []
  let done = false
  let pendingSignal: Promise<void> | undefined
  let notifyPendingSignal: (() => void) | undefined

  function signal() {
    if (!notifyPendingSignal) {
      return
    }

    const notify = notifyPendingSignal
    notifyPendingSignal = undefined
    pendingSignal = undefined
    notify()
  }

  function waitForSignal() {
    if (!pendingSignal) {
      pendingSignal = new Promise<void>((resolve) => {
        notifyPendingSignal = resolve
      })
    }

    return pendingSignal
  }

  return {
    push(item: T) {
      if (done) {
        throw new Error("Cannot push to a closed event queue")
      }

      items.push(item)
      signal()
    },
    close() {
      done = true
      signal()
    },
    async *stream() {
      while (true) {
        if (items.length > 0) {
          yield items.shift() as T
          continue
        }

        if (done) {
          return
        }

        await waitForSignal()
      }
    },
  }
}
