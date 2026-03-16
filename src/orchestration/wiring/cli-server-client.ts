import { createEventQueue } from "../runtime/stream"
import { getDefaultCliStoragePath } from "./runtime"
import {
  createPermissionRepository,
  type PermissionRepository,
  type StoredPermissionRequest,
} from "../../permission/repo"
import type { OrchestrationModelPort } from "../ports/model"
import { createAgentServer } from "./server"
import type { ServerEvent } from "./server-events"
import {
  createConversationRepository as createStorageRepository,
  openConversationDatabase as openStorageDatabase,
  type ConversationRepository as StorageRepository,
  type StoredMessage,
  type StoredRun,
  type StoredSession,
} from "../../conversation/repo"

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
  createSession(input: {
    directory: string
    workspaceRoot: string
  }): Promise<StoredSession>
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
    createSession(inputValue) {
      return requestJson<{ session: StoredSession }>("/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(inputValue),
      }).then((data) => data.session)
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
  workspaceRoot: string
  repository?: StorageRepository
  permissionRepository?: PermissionRepository
}) {
  const database =
    input.repository == null ? openStorageDatabase(getDefaultCliStoragePath(input.workspaceRoot)) : null
  if (input.repository && !input.permissionRepository) {
    throw new Error("permissionRepository is required when repository is provided")
  }
  const repository =
    input.repository ??
    createStorageRepository({
      database: database!,
    })
  const permissionRepository =
    input.permissionRepository ??
    createPermissionRepository({
      database: database!,
    })
  const server = createAgentServer({
    provider: input.provider,
    repository,
    permissionRepository,
  })

  return {
    client: createAgentServerClient({
      origin: "http://server.test",
      send(request) {
        return server.fetch(request)
      },
    }),
    async close() {
      await server.stop()
      database?.close(false)
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
