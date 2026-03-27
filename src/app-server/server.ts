import { createServer as createNetServer } from "node:net"
import { mkdir, realpath, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { z, ZodError } from "zod"
import {
  createResearchToolCallbacks,
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

const createSessionBodySchema = z.object({
  directory: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(60).optional(),
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

const openProjectBodySchema = z.object({
  directory: z.string().trim().min(1),
  create: z.boolean().optional(),
})

const createProjectThreadBodySchema = z.object({
  workspaceRoot: z.string().trim().min(1),
  title: z.string().trim().min(1).max(60).optional(),
})

const saveCandidateBodySchema = z.object({
  title: z.string().trim().min(1).optional(),
})

const workspaceRootQuerySchema = z.object({
  workspaceRoot: z.string().trim().min(1),
})

type ServerInstance = ReturnType<typeof Bun.serve>
const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 5_000

type SessionSummary = {
  id: string
  workspaceRoot: string
  title: string
  updatedAt: number
  latestUserMessagePreview: string | null
}

type KnowledgeRuntime = Parameters<typeof createResearchToolCallbacks>[0]["knowledge"]

export function createAgentServer(input: {
  createRuntimeImpl: CreateServerAppRuntime
  repository: StorageRepository
  permissionRepository: PermissionRepository
  knowledge?: KnowledgeRuntime
  exportRunTraceImpl?: Parameters<typeof createServerApp>[0]["exportRunTraceImpl"]
  now?: () => number
  heartbeatIntervalMs?: number
  allowDetachedPermissionRecovery?: boolean
  fetchExternalContent?: Parameters<typeof createResearchToolCallbacks>[0]["fetchExternalContent"]
}) {
  const now = input.now ?? Date.now
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS
  const app = createServerApp({
    createRuntimeImpl(runtimeInput) {
      return input.createRuntimeImpl({
        ...runtimeInput,
        researchTools: input.knowledge
          ? createResearchToolCallbacks({
              knowledge: input.knowledge,
              fetchExternalContent: input.fetchExternalContent,
              onCandidateStaged(candidate) {
                runtimeInput.publishEvent({
                  type: "knowledge.candidate.created",
                  candidate,
                })
              },
              onAssetCreated(asset) {
                runtimeInput.publishEvent({
                  type: "knowledge.asset.created",
                  asset,
                })
              },
            })
          : runtimeInput.researchTools,
      })
    },
    repository: input.repository,
    permissionRepository: input.permissionRepository,
    exportRunTraceImpl: input.exportRunTraceImpl,
    allowDetachedPermissionRecovery: input.allowDetachedPermissionRecovery ?? true,
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

      if (request.method === "GET" && path === "projects") {
        return jsonResponse(200, {
          data: {
            projects: listProjects({
              repository: app.sessions.list(),
              knowledge: input.knowledge,
            }),
          },
        })
      }

      if (request.method === "POST" && path === "projects/open") {
        const body = await readJsonBody(request, openProjectBodySchema)
        const workspaceRoot = await resolveProjectDirectory(body.directory, body.create ?? false)

        return jsonResponse(200, {
          data: {
            project: buildProjectSummary({
              workspaceRoot,
              sessions: app.sessions.list(),
              knowledge: input.knowledge,
            }),
          },
        })
      }

      if (request.method === "GET" && path === "project") {
        const query = workspaceRootQuerySchema.parse(readQuery(url))
        return jsonResponse(200, {
          data: {
            project: buildProjectSummary({
              workspaceRoot: query.workspaceRoot,
              sessions: app.sessions.list(),
              knowledge: input.knowledge,
            }),
          },
        })
      }

      if (request.method === "GET" && path === "project/threads") {
        const query = workspaceRootQuerySchema.parse(readQuery(url))
        return jsonResponse(200, {
          data: {
            threads: app.sessions
              .list()
              .filter((session) => session.workspaceRoot === query.workspaceRoot)
              .sort((left, right) => right.updatedAt - left.updatedAt),
          },
        })
      }

      if (request.method === "POST" && path === "project/threads") {
        const body = await readJsonBody(request, createProjectThreadBodySchema)
        const workspaceRoot = await resolveProjectDirectory(body.workspaceRoot, true)
        const session = app.sessions.create({
          directory: workspaceRoot,
          workspaceRoot,
          title: body.title,
        })

        return jsonResponse(201, {
          data: {
            thread: session,
          },
        })
      }

      if (request.method === "GET" && path === "project/knowledge") {
        const query = workspaceRootQuerySchema.parse(readQuery(url))
        return jsonResponse(200, {
          data: {
            candidates: input.knowledge?.candidates.list(query.workspaceRoot) ?? [],
            assets: input.knowledge?.assets.list(query.workspaceRoot) ?? [],
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

      const candidateSaveMatch = matchPath(path, ["project", "candidates", ":candidateId", "save"])
      if (request.method === "POST" && candidateSaveMatch) {
        if (!input.knowledge) {
          return errorResponse(404, "not_found", "Knowledge runtime is not configured")
        }

        const body = await readJsonBody(request, saveCandidateBodySchema)
        const saved = await input.knowledge.candidates.saveAsSource({
          candidateId: candidateSaveMatch.candidateId,
          title: body.title,
        })
        app.events.publish({
          type: "knowledge.candidate.updated",
          candidate: saved.candidate,
        })
        app.events.publish({
          type: "knowledge.asset.created",
          asset: saved.asset,
        })

        return jsonResponse(201, {
          data: saved,
        })
      }

      const assetMatch = matchPath(path, ["project", "assets", ":assetId"])
      if (request.method === "GET" && assetMatch) {
        if (!input.knowledge) {
          return errorResponse(404, "not_found", "Knowledge runtime is not configured")
        }

        return jsonResponse(200, {
          data: await input.knowledge.assets.read(assetMatch.assetId),
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
    error instanceof ProjectDirectoryNotFoundError
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
    error instanceof ProjectDirectoryValidationError
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

async function resolveProjectDirectory(directory: string, createIfMissing: boolean) {
  const resolved = resolve(directory)

  if (createIfMissing) {
    await mkdir(resolved, { recursive: true })
  }

  try {
    const metadata = await stat(resolved)
    if (!metadata.isDirectory()) {
      throw new ProjectDirectoryValidationError(`${directory} is not a directory`)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new ProjectDirectoryNotFoundError(directory)
    }

    throw error
  }

  return realpath(resolved)
}

function listProjects(input: {
  repository: SessionSummary[]
  knowledge?: KnowledgeRuntime
}) {
  const workspaceRoots = new Set<string>()

  for (const session of input.repository) {
    workspaceRoots.add(session.workspaceRoot)
  }

  return [...workspaceRoots]
    .map((workspaceRoot) =>
      buildProjectSummary({
        workspaceRoot,
        sessions: input.repository,
        knowledge: input.knowledge,
      }),
    )
    .sort((left, right) => right.latestActivityAt - left.latestActivityAt)
}

function buildProjectSummary(input: {
  workspaceRoot: string
  sessions: SessionSummary[]
  knowledge?: KnowledgeRuntime
}) {
  const threads = input.sessions
    .filter((session) => session.workspaceRoot === input.workspaceRoot)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const candidates = input.knowledge?.candidates.list(input.workspaceRoot) ?? []
  const assets = input.knowledge?.assets.list(input.workspaceRoot) ?? []
  const assetCounts = {
    source: assets.filter((asset) => asset.kind === "source").length,
    note: assets.filter((asset) => asset.kind === "note").length,
    finding: assets.filter((asset) => asset.kind === "finding").length,
    artifact: assets.filter((asset) => asset.kind === "artifact").length,
  }
  const latestActivityAt = Math.max(
    0,
    ...threads.map((thread) => thread.updatedAt),
    ...candidates.map((candidate) => candidate.createdAt),
    ...assets.map((asset) => asset.updatedAt),
  )

  return {
    workspaceRoot: input.workspaceRoot,
    name: basename(input.workspaceRoot),
    latestActivityAt,
    threadCount: threads.length,
    pendingCandidateCount: candidates.filter((candidate) => candidate.status === "candidate").length,
    assetCounts,
    threads: threads.slice(0, 6),
  }
}

class ProjectDirectoryNotFoundError extends Error {
  constructor(directory: string) {
    super(`Project directory does not exist: ${directory}`)
    this.name = "ProjectDirectoryNotFoundError"
  }
}

class ProjectDirectoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProjectDirectoryValidationError"
  }
}
