import { createServer as createNetServer } from "node:net"
import { mkdir, realpath, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { z, ZodError } from "zod"
import {
  createServerApp,
  InvalidRunStatusTransitionError,
  type CreateServerAppRuntime,
  PermissionNotFoundError,
  PermissionRequestNotAwaitingActiveRuntimeError,
  PermissionRequestNotPendingError,
  PermissionRequestRunStateError,
  RUN_TRIGGERS,
  type ServerEvent,
  ServerShuttingDownError,
  SessionAlreadyCompactingError,
  SessionBusyError,
  SessionConflictError as StorageConflictError,
  SessionNotFoundError as StorageNotFoundError,
  StartRunIdentityConflictError,
  type PermissionRepository,
  RunTraceNotFoundError,
  type SessionRepository as StorageRepository,
} from "../bootstrap"
import { serializeSseEvent } from "./events"

export { PermissionRequestNotAwaitingActiveRuntimeError } from "../bootstrap"

type ServerInstance = {
  port: number
  stop(): void
  timeout(request: Request, seconds: number): void
}

declare const Bun: {
  serve(options: {
    hostname: string
    port: number
    fetch: (request: Request, server: ServerInstance) => Response | Promise<Response>
  }): ServerInstance
}

const createSessionBodySchema = z.object({
  directory: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(60).optional(),
})

export const startRunBodySchema = z.object({
  prompt: z.string().min(1),
  trigger: z.enum(RUN_TRIGGERS).optional(),
  runId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
})

export type StartRunBody = z.infer<typeof startRunBodySchema>

export function buildStartRunInput(sessionId: string, body: StartRunBody) {
  return {
    sessionId,
    prompt: body.prompt,
    trigger: body.trigger,
    runId: body.runId,
    messageId: body.messageId,
    agent: body.agent,
  }
}

const replyPermissionBodySchema = z.object({
  decision: z.enum(["allow", "deny"]),
})

const openWorkspaceBodySchema = z.object({
  directory: z.string().trim().min(1),
  create: z.boolean().optional(),
})

const createWorkspaceSessionBodySchema = z.object({
  workspaceRoot: z.string().trim().min(1),
  title: z.string().trim().min(1).max(60).optional(),
})

const addActiveSkillsBodySchema = z.object({
  activeSkills: z.array(z.string().trim().min(1)).max(100),
})

const setCurrentAgentBodySchema = z.object({
  agent: z.string().trim().min(1),
})

const workspaceRootQuerySchema = z.object({
  workspaceRoot: z.string().trim().min(1),
})

const primaryAgentsQuerySchema = z.object({
  workspaceRoot: z.string().trim().min(1).optional(),
})

const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 5_000

type SessionSummary = {
  id: string
  workspaceRoot: string
  title: string
  updatedAt: number
  latestUserMessagePreview: string | null
  activeSkills: string[]
  latestRunStatus: "queued" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled" | null
}

export function createAgentServer(input: {
  createRuntimeImpl: CreateServerAppRuntime
  repository: StorageRepository
  permissionRepository: PermissionRepository
  exportRunTraceImpl?: Parameters<typeof createServerApp>[0]["exportRunTraceImpl"]
  listSkillCatalogImpl?: Parameters<typeof createServerApp>[0]["listSkillCatalogImpl"]
  listPrimaryAgentsImpl?: (workspaceRoot?: string) => Promise<Array<{ name: string; description: string }>>
  deleteSessionImpl?: (sessionId: string) => void
  now?: () => number
  heartbeatIntervalMs?: number
}) {
  const now = input.now ?? Date.now
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS
  const app = createServerApp({
    createRuntimeImpl: input.createRuntimeImpl,
    repository: input.repository,
    permissionRepository: input.permissionRepository,
    deleteSessionImpl: input.deleteSessionImpl,
    exportRunTraceImpl: input.exportRunTraceImpl,
    listSkillCatalogImpl: input.listSkillCatalogImpl,
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

      if (request.method === "GET" && path === "workspaces") {
        return jsonResponse(200, {
          data: {
            workspaces: listWorkspaces({
              repository: app.sessions.list(),
            }),
          },
        })
      }

      if (request.method === "POST" && path === "workspaces/open") {
        const body = await readJsonBody(request, openWorkspaceBodySchema)
        const workspaceRoot = await resolveWorkspaceDirectory(body.directory, body.create ?? false)

        return jsonResponse(200, {
          data: {
            workspace: buildWorkspaceSummary({
              workspaceRoot,
              sessions: app.sessions.list(),
            }),
          },
        })
      }

      if (request.method === "GET" && path === "workspace") {
        const query = workspaceRootQuerySchema.parse(readQuery(url))
        return jsonResponse(200, {
          data: {
            workspace: buildWorkspaceSummary({
              workspaceRoot: query.workspaceRoot,
              sessions: app.sessions.list(),
            }),
          },
        })
      }

      if (request.method === "GET" && path === "workspace/sessions") {
        const query = workspaceRootQuerySchema.parse(readQuery(url))
        return jsonResponse(200, {
          data: {
            sessions: app.sessions
              .list()
              .filter((session) => session.workspaceRoot === query.workspaceRoot)
              .sort((left, right) => right.updatedAt - left.updatedAt),
          },
        })
      }

      if (request.method === "GET" && path === "workspace/skills") {
        const query = workspaceRootQuerySchema.parse(readQuery(url))
        return jsonResponse(200, {
          data: {
            skills: await app.workspaces.skills(query.workspaceRoot),
          },
        })
      }

      if (request.method === "POST" && path === "workspace/sessions") {
        const body = await readJsonBody(request, createWorkspaceSessionBodySchema)
        const workspaceRoot = await resolveWorkspaceDirectory(body.workspaceRoot, true)
        const session = app.sessions.create({
          directory: workspaceRoot,
          workspaceRoot,
          title: body.title,
        })

        return jsonResponse(201, {
          data: {
            session,
          },
        })
      }

      if (request.method === "GET" && path === "agents/primary") {
        const query = primaryAgentsQuerySchema.parse(readQuery(url))
        const agents = await (input.listPrimaryAgentsImpl?.(query.workspaceRoot) ?? Promise.resolve([]))
        return jsonResponse(200, {
          data: {
            agents,
          },
        })
      }

      const sessionStateMatch = matchPath(path, ["sessions", ":sessionId"])
      if (request.method === "DELETE" && sessionStateMatch) {
        if (!input.deleteSessionImpl) {
          throw new Error("Session deletion is not configured for this server instance")
        }

        app.sessions.delete(sessionStateMatch.sessionId)
        return jsonResponse(200, {
          data: {
            sessionId: sessionStateMatch.sessionId,
          },
        })
      }

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

      const sessionActiveSkillsMatch = matchPath(path, ["sessions", ":sessionId", "active-skills"])
      if (request.method === "POST" && sessionActiveSkillsMatch) {
        const body = await readJsonBody(request, addActiveSkillsBodySchema)
        return jsonResponse(200, {
          data: {
            session: app.sessions.addActiveSkills({
              sessionId: sessionActiveSkillsMatch.sessionId,
              activeSkills: body.activeSkills,
            }),
          },
        })
      }

      const sessionAgentMatch = matchPath(path, ["sessions", ":sessionId", "agent"])
      if (request.method === "POST" && sessionAgentMatch) {
        const body = await readJsonBody(request, setCurrentAgentBodySchema)
        return jsonResponse(200, {
          data: {
            session: app.sessions.setCurrentAgent({
              sessionId: sessionAgentMatch.sessionId,
              agent: body.agent,
            }),
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
        const started = await app.runs.start(buildStartRunInput(sessionRunsMatch.sessionId, body))

        return jsonResponse(201, {
          data: started,
        })
      }

      const sessionCompactMatch = matchPath(path, ["sessions", ":sessionId", "compact"])
      if (request.method === "POST" && sessionCompactMatch) {
        return jsonResponse(201, {
          data: await app.runs.compact(sessionCompactMatch.sessionId),
        })
      }

      const runMatch = matchPath(path, ["runs", ":runId"])
      if (request.method === "GET" && runMatch) {
        return jsonResponse(200, {
          data: app.runs.get(runMatch.runId),
        })
      }

      const runTraceMatch = matchPath(path, ["runs", ":runId", "trace"])
      if (request.method === "GET" && runTraceMatch) {
        return jsonResponse(200, {
          data: {
            trace: app.runs.trace(runTraceMatch.runId),
          },
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
        fetch: (request: Request, activeServer: ServerInstance) => handleRequest(request, activeServer),
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

function readQuery(url: URL) {
  return Object.fromEntries(url.searchParams.entries())
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
  if (
    error instanceof StorageNotFoundError ||
    error instanceof PermissionNotFoundError ||
    error instanceof RunTraceNotFoundError ||
    error instanceof WorkspaceDirectoryNotFoundError
  ) {
    return {
      status: 404,
      code: "not_found",
      message: error.message,
    }
  }

  if (
    error instanceof ZodError ||
    isJsonBodyError(error) ||
    error instanceof WorkspaceDirectoryValidationError
  ) {
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

  if (error instanceof SessionAlreadyCompactingError) {
    return {
      status: 409,
      code: "already_compacting",
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

async function resolveWorkspaceDirectory(directory: string, createIfMissing: boolean) {
  const resolved = resolve(directory)

  if (createIfMissing) {
    await mkdir(resolved, { recursive: true })
  }

  try {
    const metadata = await stat(resolved)
    if (!metadata.isDirectory()) {
      throw new WorkspaceDirectoryValidationError(`${directory} is not a directory`)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new WorkspaceDirectoryNotFoundError(directory)
    }

    throw error
  }

  return realpath(resolved)
}

function listWorkspaces(input: {
  repository: SessionSummary[]
}) {
  const workspaceRoots = new Set<string>()

  for (const session of input.repository) {
    workspaceRoots.add(session.workspaceRoot)
  }

  return [...workspaceRoots]
    .map((workspaceRoot) =>
      buildWorkspaceSummary({
        workspaceRoot,
        sessions: input.repository,
      }),
    )
    .sort((left, right) => right.latestActivityAt - left.latestActivityAt)
}

function buildWorkspaceSummary(input: {
  workspaceRoot: string
  sessions: SessionSummary[]
}) {
  const sessions = input.sessions
    .filter((session) => session.workspaceRoot === input.workspaceRoot)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const latestActivityAt = Math.max(0, ...sessions.map((session) => session.updatedAt))

  return {
    workspaceRoot: input.workspaceRoot,
    name: basename(input.workspaceRoot),
    latestActivityAt,
    sessionCount: sessions.length,
    hasBusySession: sessions.some((session) => isBusySessionRunStatus(session.latestRunStatus)),
    sessions: sessions.slice(0, 6),
  }
}

function isBusySessionRunStatus(status: SessionSummary["latestRunStatus"]) {
  return status === "queued" || status === "running" || status === "waiting_permission"
}

class WorkspaceDirectoryNotFoundError extends Error {
  constructor(directory: string) {
    super(`Workspace directory does not exist: ${directory}`)
    this.name = "WorkspaceDirectoryNotFoundError"
  }
}

class WorkspaceDirectoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceDirectoryValidationError"
  }
}
