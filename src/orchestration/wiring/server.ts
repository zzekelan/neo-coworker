import { createServer as createNetServer } from "node:net"
import { z, ZodError } from "zod"
import {
  InvalidRunStatusTransitionError,
  SessionBusyError,
  StartRunIdentityConflictError,
} from "../../session/service"
import { PermissionNotFoundError, type PermissionRepository } from "../../permission"
import {
  PermissionRequestNotPendingError,
  PermissionRequestRunStateError,
} from "../../permission"
import { PermissionRequestNotAwaitingActiveRuntimeError } from "../index"
import {
  RUN_TRIGGERS,
  SessionConflictError as StorageConflictError,
  SessionNotFoundError as StorageNotFoundError,
  type SessionRepository as StorageRepository,
} from "../../session/repo"
import type { ServerEvent } from "./server-events"
import { serializeSseEvent } from "./server-events"
import {
  createServerApp,
  type CreateServerAppRuntime,
  ServerShuttingDownError,
} from "./server-app"

export { PermissionRequestNotAwaitingActiveRuntimeError } from "../index"

const createSessionBodySchema = z.object({
  directory: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
})

const startRunBodySchema = z.object({
  prompt: z.string().min(1),
  trigger: z.enum(RUN_TRIGGERS).optional(),
  runId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
})

const replyPermissionBodySchema = z.object({
  decision: z.enum(["allow", "deny"]),
})

type ServerInstance = ReturnType<typeof Bun.serve>
const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 5_000

export function createAgentServer(input: {
  createRuntimeImpl: CreateServerAppRuntime
  repository: StorageRepository
  permissionRepository: PermissionRepository
  now?: () => number
  heartbeatIntervalMs?: number
}) {
  const now = input.now ?? Date.now
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS
  const app = createServerApp({
    createRuntimeImpl: input.createRuntimeImpl,
    repository: input.repository,
    permissionRepository: input.permissionRepository,
    now,
  })
  let server: ServerInstance | null = null
  let baseUrl = ""
  let nextHeartbeatId = 0

  async function handleRequest(request: Request, activeServer?: ServerInstance) {
    const url = new URL(request.url)
    const path = trimSlashes(url.pathname)

    try {
      if (request.method === "GET" && path === "health") {
        return jsonResponse(200, {
          data: {
            ok: true,
          },
        })
      }

      if (request.method === "GET" && path === "events") {
        activeServer?.timeout(request, 0)
        return createSseResponse(request)
      }

      if (request.method === "GET" && path === "sessions") {
        return jsonResponse(200, {
          data: {
            sessions: app.sessions.list(),
          },
        })
      }

      if (request.method === "POST" && path === "sessions") {
        const body = await readJsonBody(request, createSessionBodySchema)
        const session = app.sessions.create(body)
        return jsonResponse(201, {
          data: {
            session,
          },
        })
      }

      const sessionStateMatch = matchPath(path, ["sessions", ":sessionId"])
      if (request.method === "GET" && sessionStateMatch) {
        return jsonResponse(200, {
          data: app.sessions.get(sessionStateMatch.sessionId),
        })
      }

      const sessionTranscriptMatch = matchPath(path, ["sessions", ":sessionId", "transcript"])
      if (request.method === "GET" && sessionTranscriptMatch) {
        return jsonResponse(200, {
          data: {
            transcript: app.sessions.transcript(sessionTranscriptMatch.sessionId),
          },
        })
      }

      const sessionRunsMatch = matchPath(path, ["sessions", ":sessionId", "runs"])
      if (request.method === "GET" && sessionRunsMatch) {
        return jsonResponse(200, {
          data: {
            runs: app.runs.list(sessionRunsMatch.sessionId),
          },
        })
      }

      if (request.method === "POST" && sessionRunsMatch) {
        const body = await readJsonBody(request, startRunBodySchema)
        const started = await app.runs.start({
          sessionId: sessionRunsMatch.sessionId,
          prompt: body.prompt,
          trigger: body.trigger,
          runId: body.runId,
          messageId: body.messageId,
        })

        return jsonResponse(201, {
          data: started,
        })
      }

      const runMatch = matchPath(path, ["runs", ":runId"])
      if (request.method === "GET" && runMatch) {
        return jsonResponse(200, {
          data: app.runs.get(runMatch.runId),
        })
      }

      const runCancelMatch = matchPath(path, ["runs", ":runId", "cancel"])
      if (request.method === "POST" && runCancelMatch) {
        return jsonResponse(200, {
          data: {
            run: app.runs.cancel(runCancelMatch.runId),
          },
        })
      }

      const permissionReplyMatch = matchPath(path, ["permissions", ":requestId", "reply"])
      if (request.method === "POST" && permissionReplyMatch) {
        const body = await readJsonBody(request, replyPermissionBodySchema)
        return jsonResponse(200, {
          data: app.permissions.reply({
            requestId: permissionReplyMatch.requestId,
            decision: body.decision,
          }),
        })
      }

      return errorResponse(404, "not_found", `Unknown route: ${request.method} ${url.pathname}`)
    } catch (error) {
      const failure = mapHttpError(error)
      return errorResponse(failure.status, failure.code, failure.message)
    }
  }

  function buildHeartbeatEvent(): ServerEvent {
    nextHeartbeatId += 1

    return {
      id: `heartbeat_${nextHeartbeatId}`,
      type: "heartbeat",
      time: now(),
    }
  }

  function createSseResponse(request: Request) {
    const encoder = new TextEncoder()
    const subscription = app.subscribe()

    return new Response(
      new ReadableStream({
        start(controller) {
          let closed = false
          let heartbeatTimer: ReturnType<typeof setInterval> | null = null

          function send(event: ServerEvent) {
            if (closed) {
              return
            }

            try {
              controller.enqueue(encoder.encode(serializeSseEvent(event)))
            } catch {
              close()
            }
          }

          function close() {
            if (closed) {
              return
            }

            closed = true
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer)
              heartbeatTimer = null
            }
            request.signal.removeEventListener("abort", close)
            subscription.unsubscribe()

            try {
              controller.close()
            } catch {
              // The stream may already be closed by the runtime.
            }
          }

          heartbeatTimer = setInterval(() => {
            send(buildHeartbeatEvent())
          }, heartbeatIntervalMs)

          request.signal.addEventListener("abort", close)
          send(buildHeartbeatEvent())

          void (async () => {
            try {
              for await (const event of subscription.events) {
                send(event)
              }
            } finally {
              close()
            }
          })()
        },
        cancel() {
          subscription.unsubscribe()
        },
      }),
      {
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
        },
      },
    )
  }

  return {
    get baseUrl() {
      return baseUrl
    },
    async start(options: { hostname?: string; port?: number } = {}) {
      if (server) {
        throw new Error("Server is already started")
      }

      const hostname = options.hostname ?? "127.0.0.1"
      const port = await resolveListenPort(hostname, options.port)
      server = Bun.serve({
        hostname,
        port,
        fetch: (request, activeServer) => handleRequest(request, activeServer),
      })
      baseUrl = `http://${hostname}:${server.port}`
    },
    async stop() {
      const activeServer = server
      server = null

      activeServer?.stop()
      await app.close()
    },
    fetch: handleRequest,
  }
}

async function readJsonBody<T extends z.ZodTypeAny>(request: Request, schema: T) {
  let body: unknown

  try {
    body = await request.json()
  } catch {
    throw new Error("Request body must be valid JSON")
  }

  return schema.parse(body)
}

function trimSlashes(pathname: string) {
  return pathname.replace(/^\/+|\/+$/g, "")
}

function matchPath(pathname: string, pattern: string[]) {
  const segments = pathname.split("/").filter(Boolean)
  if (segments.length !== pattern.length) {
    return null
  }

  const params: Record<string, string> = {}

  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]
    const actual = segments[index]

    if (!expected || !actual) {
      return null
    }

    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual)
      continue
    }

    if (expected !== actual) {
      return null
    }
  }

  return params
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  })
}

function errorResponse(status: number, code: string, message: string) {
  return jsonResponse(status, {
    error: {
      code,
      message,
    },
  })
}

function mapHttpError(error: unknown) {
  if (error instanceof StorageNotFoundError || error instanceof PermissionNotFoundError) {
    return {
      status: 404,
      code: "not_found",
      message: error.message,
    }
  }

  if (error instanceof ZodError || isJsonBodyError(error)) {
    return {
      status: 400,
      code: "validation_error",
      message: error instanceof Error ? error.message : "Request validation failed",
    }
  }

  if (
    error instanceof InvalidRunStatusTransitionError ||
    error instanceof SessionBusyError ||
    error instanceof StartRunIdentityConflictError ||
    error instanceof PermissionRequestNotPendingError ||
    error instanceof PermissionRequestRunStateError ||
    error instanceof PermissionRequestNotAwaitingActiveRuntimeError ||
    error instanceof StorageConflictError
  ) {
    return {
      status: 409,
      code: "invalid_state",
      message: error.message,
    }
  }

  if (error instanceof ServerShuttingDownError) {
    return {
      status: 503,
      code: "service_unavailable",
      message: error.message,
    }
  }

  if (error instanceof Error) {
    return {
      status: 500,
      code: "internal_error",
      message: error.message,
    }
  }

  return {
    status: 500,
    code: "internal_error",
    message: "Unknown server error",
  }
}

function isJsonBodyError(error: unknown) {
  return error instanceof Error && error.message === "Request body must be valid JSON"
}

async function resolveListenPort(hostname: string, port: number | undefined) {
  if (port && port > 0) {
    return port
  }

  return new Promise<number>((resolve, reject) => {
    const server = createNetServer()
    server.once("error", reject)
    server.listen(0, hostname, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Failed to allocate a TCP port for the server"))
        })
        return
      }

      server.close((closeError) => {
        if (closeError) {
          reject(closeError)
          return
        }

        resolve(address.port)
      })
    })
  })
}
