import {
  isTerminalRunStatus,
  type OrchestrationModelPort,
  type PermissionDecision,
  type ServerEvent,
  type StoredPermissionRequest,
  type StoredSession,
} from "../bootstrap"
import type { CliIO } from "./cli-io"
import { createCliChatRenderer } from "./chat-render"
import { createCliRenderState, renderServerEvent } from "./cli-render"
import {
  AgentServerClientError,
  createLocalCliServerClient,
  type AgentServerClient,
  type CliServerClientHandle,
} from "./cli-server-client"

export { createStdioCliIo } from "./cli-io"
export { createAgentServerClient, createLocalCliServerClient } from "./cli-server-client"

export type RunCommand = {
  command: "run"
  prompt: string
  sessionId?: string
}

export type ChatCommand = {
  command: "chat"
  sessionId?: string
}

export type CliCommand = RunCommand | ChatCommand

export function parseCliCommand(argv: string[]): CliCommand {
  const [command, ...rest] = argv

  if (command === "run") {
    const parsed = parseCommandOptions(rest)
    if (parsed.positionals.length === 0) {
      throw new Error("A prompt is required")
    }

    return {
      command,
      prompt: parsed.positionals.join(" "),
      sessionId: parsed.sessionId,
    }
  }

  if (command === "chat") {
    const parsed = parseCommandOptions(rest, {
      allowPayload: false,
    })

    if (parsed.positionals.length > 0) {
      throw new Error("`chat` does not accept a prompt")
    }

    return {
      command,
      sessionId: parsed.sessionId,
    }
  }

  throw new Error("Only `run` and `chat` are supported")
}

export function parseRunCommand(argv: string[]): RunCommand {
  const command = parseCliCommand(argv)

  if (command.command !== "run") {
    throw new Error("Expected a `run` command")
  }

  return command
}

function parseCommandOptions(
  argv: string[],
  options: {
    allowPayload?: boolean
  } = {},
) {
  const allowPayload = options.allowPayload ?? true
  let sessionId: string | undefined
  const positionals: string[] = []
  let parsingOptions = true

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (!argument) {
      continue
    }

    if (parsingOptions && argument === "--") {
      if (!allowPayload) {
        throw new Error("`chat` does not accept `--`")
      }

      parsingOptions = false
      continue
    }

    if (parsingOptions && argument === "--session") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--session requires a value")
      }

      sessionId = value
      index += 1
      continue
    }

    if (parsingOptions && argument.startsWith("--session=")) {
      const value = argument.slice("--session=".length)
      if (!value) {
        throw new Error("--session requires a value")
      }

      sessionId = value
      continue
    }

    if (parsingOptions && argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`)
    }

    parsingOptions = false
    positionals.push(argument)
  }

  return {
    sessionId,
    positionals,
  }
}

type RunCliClientInput = {
  client: AgentServerClient
  provider?: never
  createLocalCliServerClientImpl?: never
  createLocalRuntimeImpl?: never
  createLocalStorageImpl?: never
}

type RunCliProviderInput = {
  client?: never
  provider: OrchestrationModelPort
  createLocalCliServerClientImpl?: typeof createLocalCliServerClient
  createLocalRuntimeImpl: Parameters<typeof createLocalCliServerClient>[0]["createRuntimeImpl"]
  createLocalStorageImpl: (workspaceRoot: string) =>
    | Pick<
        Parameters<typeof createLocalCliServerClient>[0],
        "repository" | "permissionRepository" | "closeImpl"
      >
    | Promise<
        Pick<
          Parameters<typeof createLocalCliServerClient>[0],
          "repository" | "permissionRepository" | "closeImpl"
        >
      >
}

export type RunCliInput = {
  argv: string[]
  io: CliIO
  cwd?: string
  workspaceRoot?: string
} & (RunCliClientInput | RunCliProviderInput)

type PendingPermissionReply = {
  requestId: string
  controller: AbortController
  completion: Promise<{
    requestId: string
    error: unknown | null
    sent: boolean
  }>
}

type WatchChatRunResult = {
  terminalStatus: ReturnType<typeof extractTerminalRunStatus>["status"]
  terminalError: string | null
  exitedWhileBlocked: boolean
}

function getPermissionDecision(answer: string): PermissionDecision {
  const normalized = answer.trim().toLowerCase()
  return normalized === "y" || normalized === "yes" ? "allow" : "deny"
}

type PermissionRequestedServerEvent = Extract<ServerEvent, { type: "permission.requested" }>

async function handlePermissionEvent(
  event: PermissionRequestedServerEvent,
  client: AgentServerClient,
  io: CliIO,
  signal?: AbortSignal,
) {
  const answer = await io.prompt(`permission> Allow ${event.permissionRequest.reason}? [y/N] `, {
    signal,
  })

  if (signal?.aborted) {
    return false
  }

  await client.replyPermission({
    requestId: event.permissionRequest.id,
    decision: getPermissionDecision(answer),
  })

  return true
}

function startPendingPermissionReply(
  event: PermissionRequestedServerEvent,
  client: AgentServerClient,
  io: CliIO,
): PendingPermissionReply {
  const controller = new AbortController()

  return {
    requestId: event.permissionRequest.id,
    controller,
    completion: handlePermissionEvent(event, client, io, controller.signal)
      .then((sent) => ({
        requestId: event.permissionRequest.id,
        error: null,
        sent,
      }))
      .catch((error) => ({
        requestId: event.permissionRequest.id,
        error: isAbortError(error) ? null : error,
        sent: false,
      })),
  }
}

async function resolveClient(input: RunCliInput, workspaceRoot: string): Promise<CliServerClientHandle> {
  if ("client" in input && input.client) {
    return {
      client: input.client,
      async close() {},
    }
  }

  if ("provider" in input && input.provider) {
    const createLocalClient =
      input.createLocalCliServerClientImpl ?? createLocalCliServerClient
    const localStorage = await input.createLocalStorageImpl(workspaceRoot)

    return createLocalClient({
      provider: input.provider,
      repository: localStorage.repository,
      permissionRepository: localStorage.permissionRepository,
      createRuntimeImpl: input.createLocalRuntimeImpl,
      closeImpl: localStorage.closeImpl,
    })
  }

  throw new Error("runCli requires either a server client or provider")
}

export async function runCli(input: RunCliInput) {
  const command = parseCliCommand(input.argv)
  const cwd = input.cwd ?? process.cwd()
  const workspaceRoot = input.workspaceRoot ?? cwd
  const clientHandle = await resolveClient(input, workspaceRoot)

  try {
    if (command.command === "run") {
      await runSinglePromptCli({
        command,
        io: input.io,
        cwd,
        workspaceRoot,
        clientHandle,
      })
      return
    }

    await runChatCli({
      command,
      io: input.io,
      cwd,
      workspaceRoot,
      clientHandle,
    })
  } finally {
    await clientHandle.close()
    input.io.close?.()
  }
}

async function runSinglePromptCli(input: {
  command: RunCommand
  io: CliIO
  cwd: string
  workspaceRoot: string
  clientHandle: CliServerClientHandle
}) {
  const renderState = createCliRenderState()
  let activeRunId: string | null = null
  let cancelRequested = false
  let cancelDispatched = false
  let cancelError: unknown = null

  async function requestCancel(runId: string) {
    if (cancelDispatched) {
      return
    }

    cancelDispatched = true

    try {
      await input.clientHandle.client.cancelRun(runId)
    } catch (error) {
      if (isIgnorableCancelError(error)) {
        return
      }

      cancelError = error
    }
  }

  const cleanupSigint =
    input.io.onSigint?.(() => {
      if (!activeRunId) {
        cancelRequested = true
        return
      }

      void requestCancel(activeRunId)
    }) ?? undefined

  try {
    const sessionId =
      input.command.sessionId ??
      (await input.clientHandle.client.createSession({
        directory: input.cwd,
        workspaceRoot: input.workspaceRoot,
      })).id

    if (!input.command.sessionId) {
      input.io.write(`session.created ${sessionId}\n`)
    }

    const subscription = await input.clientHandle.client.subscribe()

    try {
      const started = await input.clientHandle.client.startRun({
        sessionId,
        prompt: input.command.prompt,
        trigger: "cli",
      })
      activeRunId = started.run.id
      cancelDispatched = false
      cancelError = null

      if (input.command.sessionId) {
        input.io.write(`session.selected ${sessionId}\n`)
      }

      if (cancelRequested) {
        cancelRequested = false
        await requestCancel(activeRunId)
      }

      let terminalStatus: ReturnType<typeof extractTerminalRunStatus>["status"] = null
      let terminalError: string | null = null
      const eventIterator = subscription.events[Symbol.asyncIterator]()
      let nextEventPromise: Promise<IteratorResult<ServerEvent>> | null = null
      let pendingPermission: PendingPermissionReply | null = null

      function readNextEvent() {
        if (!nextEventPromise) {
          nextEventPromise = eventIterator.next().finally(() => {
            nextEventPromise = null
          })
        }

        return nextEventPromise
      }

      while (true) {
        const next =
          pendingPermission == null
            ? ({ type: "event", result: await readNextEvent() } as const)
            : await Promise.race([
                readNextEvent().then((result) => ({ type: "event", result } as const)),
                pendingPermission.completion.then((result) => ({ type: "permission", result } as const)),
              ])

        if (next.type === "permission") {
          if (pendingPermission?.requestId === next.result.requestId) {
            pendingPermission = null
          }

          if (next.result.error) {
            throw next.result.error
          }

          continue
        }

        if (next.result.done) {
          break
        }

        const event = next.result.value
        if (!isActiveRunEvent(event, activeRunId)) {
          continue
        }

        const rendered = renderServerEvent(renderState, event)
        if (rendered) {
          input.io.write(rendered)
        }

        if (event.type === "permission.requested") {
          if (pendingPermission) {
            throw new Error(`Run ${activeRunId} received overlapping permission requests`)
          }

          pendingPermission = startPendingPermissionReply(event, input.clientHandle.client, input.io)
        }

        const terminal = extractTerminalRunStatus(event)
        if (terminal.status) {
          terminalStatus = terminal.status
          terminalError = terminal.error
          pendingPermission?.controller.abort()
          pendingPermission = null
          break
        }
      }

      pendingPermission?.controller.abort()

      if (terminalStatus == null) {
        const currentRun = await input.clientHandle.client.getRun(activeRunId)

        if (!isTerminalRunStatus(currentRun.run.status)) {
          throw new Error(`Run ${activeRunId} ended without reaching a terminal state`)
        }

        terminalStatus = currentRun.run.status
        terminalError = currentRun.run.errorText
      }

      if (terminalStatus === "failed") {
        throw new Error(terminalError ?? `Run ${activeRunId} failed`)
      }

      if (cancelError) {
        throw cancelError
      }
    } finally {
      await subscription.close()
    }
  } finally {
    cleanupSigint?.()
  }
}

async function runChatCli(input: {
  command: ChatCommand
  io: CliIO
  cwd: string
  workspaceRoot: string
  clientHandle: CliServerClientHandle
}) {
  let currentSessionId = input.command.sessionId ?? null
  let activeRunId: string | null = null
  let activePermissionPrompt: PendingPermissionReply | null = null
  let cancelDispatched = false
  let cancelError: unknown = null
  let exitRequested = false
  let promptController: AbortController | null = null

  async function requestCancel(runId: string) {
    if (cancelDispatched) {
      return
    }

    cancelDispatched = true

    try {
      await input.clientHandle.client.cancelRun(runId)
    } catch (error) {
      if (isIgnorableCancelError(error)) {
        return
      }

      cancelError = error
    }
  }

  const cleanupSigint =
    input.io.onSigint?.(() => {
      if (activePermissionPrompt) {
        exitRequested = true
        activePermissionPrompt.controller.abort()
        return
      }

      if (activeRunId) {
        void requestCancel(activeRunId)
        return
      }

      exitRequested = true
      promptController?.abort()
    }) ?? undefined

  try {
    while (!exitRequested) {
      if (currentSessionId) {
        const resumeResult = await resumeExistingChatSession({
          sessionId: currentSessionId,
          client: input.clientHandle.client,
          io: input.io,
          workspaceRoot: input.workspaceRoot,
          setActivePermissionPrompt(value) {
            activePermissionPrompt = value
          },
          getExitRequested() {
            return exitRequested
          },
          setActiveRunId(value) {
            activeRunId = value
            if (value) {
              cancelDispatched = false
              cancelError = null
            }
          },
        })

        activePermissionPrompt = null
        activeRunId = null

        if (cancelError) {
          throw cancelError
        }

        if (resumeResult === "exit") {
          break
        }
      }

      promptController = new AbortController()

      let promptText: string
      try {
        promptText = await input.io.prompt("you> ", {
          signal: promptController.signal,
        })
      } catch (error) {
        if (isAbortError(error)) {
          if (exitRequested) {
            break
          }

          continue
        }

        throw error
      } finally {
        promptController = null
      }

      const trimmed = promptText.trim()
      if (!trimmed) {
        continue
      }

      if (trimmed === "/exit") {
        break
      }

      if (trimmed === "/resume") {
        const selectedSession = await selectResumeSession({
          client: input.clientHandle.client,
          io: input.io,
          workspaceRoot: input.workspaceRoot,
        })

        if (selectedSession) {
          currentSessionId = selectedSession.id
          input.io.write(`session> ${selectedSession.title}\n`)
        }

        continue
      }

      if (trimmed.startsWith("/")) {
        input.io.write(`status> unknown command: ${trimmed}\n`)
        continue
      }

      if (!currentSessionId) {
        currentSessionId = (
          await input.clientHandle.client.createSession({
            directory: input.cwd,
            workspaceRoot: input.workspaceRoot,
          })
        ).id
      }

      const runResult = await runChatTurn({
        client: input.clientHandle.client,
        io: input.io,
        workspaceRoot: input.workspaceRoot,
        sessionId: currentSessionId,
        prompt: promptText,
        getExitRequested() {
          return exitRequested
        },
        setActivePermissionPrompt(value) {
          activePermissionPrompt = value
        },
        setActiveRunId(value) {
          activeRunId = value
          if (value) {
            cancelDispatched = false
            cancelError = null
          }
        },
      })

      activePermissionPrompt = null
      activeRunId = null

      if (cancelError) {
        throw cancelError
      }

      if (runResult === "exit") {
        break
      }
    }
  } finally {
    cleanupSigint?.()
  }
}

async function runChatTurn(input: {
  client: AgentServerClient
  io: CliIO
  workspaceRoot: string
  sessionId: string
  prompt: string
  getExitRequested(): boolean
  setActivePermissionPrompt(value: PendingPermissionReply | null): void
  setActiveRunId(value: string | null): void
}) {
  const renderer = createCliChatRenderer({
    io: input.io,
    workspaceRoot: input.workspaceRoot,
  })
  renderer.renderUserPrompt(input.prompt)

  const subscription = await input.client.subscribe()

  try {
    const started = await input.client.startRun({
      sessionId: input.sessionId,
      prompt: input.prompt,
      trigger: "cli",
    })
    input.setActiveRunId(started.run.id)

    const watched = await watchChatRun({
      client: input.client,
      io: input.io,
      runId: started.run.id,
      subscription,
      renderer,
      getExitRequested: input.getExitRequested,
      setActivePermissionPrompt: input.setActivePermissionPrompt,
    })

    if (watched.exitedWhileBlocked) {
      return "exit" as const
    }

    if (watched.terminalStatus == null) {
      const currentRun = await input.client.getRun(started.run.id)

      if (!isTerminalRunStatus(currentRun.run.status)) {
        throw new Error(`Run ${started.run.id} ended without reaching a terminal state`)
      }
    }

    return "continue" as const
  } finally {
    input.setActivePermissionPrompt(null)
    input.setActiveRunId(null)
    renderer.finish()
    await subscription.close()
  }
}

async function resumeExistingChatSession(input: {
  sessionId: string
  client: AgentServerClient
  io: CliIO
  workspaceRoot: string
  setActivePermissionPrompt(value: PendingPermissionReply | null): void
  setActiveRunId(value: string | null): void
  getExitRequested(): boolean
}) {
  const snapshot = await input.client.getSession(input.sessionId)
  const activeRun = snapshot.activeRun

  if (!activeRun) {
    return "continue" as const
  }

  const runState = await input.client.getRun(activeRun.id)
  const pendingPermission =
    activeRun.status === "waiting_permission"
      ? runState.permissionRequests.find((request) => request.status === "pending") ?? null
      : null

  if (activeRun.status === "waiting_permission" && !pendingPermission) {
    throw new Error(`Run ${activeRun.id} is waiting on permission but has no pending request`)
  }

  const subscription = await input.client.subscribe()
  const renderer = createCliChatRenderer({
    io: input.io,
    workspaceRoot: input.workspaceRoot,
  })

  try {
    input.setActiveRunId(activeRun.id)

    const watched = await watchChatRun({
      client: input.client,
      io: input.io,
      runId: activeRun.id,
      subscription,
      renderer,
      getExitRequested: input.getExitRequested,
      setActivePermissionPrompt: input.setActivePermissionPrompt,
      initialPendingPermissionRequest: pendingPermission,
    })

    if (watched.exitedWhileBlocked) {
      return "exit" as const
    }

    return "continue" as const
  } finally {
    input.setActivePermissionPrompt(null)
    input.setActiveRunId(null)
    renderer.finish()
    await subscription.close()
  }
}

async function watchChatRun(input: {
  client: AgentServerClient
  io: CliIO
  runId: string
  subscription: Awaited<ReturnType<AgentServerClient["subscribe"]>>
  renderer: ReturnType<typeof createCliChatRenderer>
  getExitRequested(): boolean
  setActivePermissionPrompt(value: PendingPermissionReply | null): void
  initialPendingPermissionRequest?: StoredPermissionRequest | null
}): Promise<WatchChatRunResult> {
  let terminalStatus: ReturnType<typeof extractTerminalRunStatus>["status"] = null
  let terminalError: string | null = null
  const eventIterator = input.subscription.events[Symbol.asyncIterator]()
  let nextEventPromise: Promise<IteratorResult<ServerEvent>> | null = null
  let pendingPermission = input.initialPendingPermissionRequest
    ? startPendingPermissionReply(
        {
          id: `permission_resume_${input.initialPendingPermissionRequest.id}`,
          time: Date.now(),
          type: "permission.requested",
          permissionRequest: input.initialPendingPermissionRequest,
        },
        input.client,
        input.io,
      )
    : null

  if (pendingPermission) {
    input.setActivePermissionPrompt(pendingPermission)
  }

  function readNextEvent() {
    if (!nextEventPromise) {
      nextEventPromise = eventIterator.next().finally(() => {
        nextEventPromise = null
      })
    }

    return nextEventPromise
  }

  while (true) {
    const next =
      pendingPermission == null
        ? ({ type: "event", result: await readNextEvent() } as const)
        : await Promise.race([
            readNextEvent().then((result) => ({ type: "event", result } as const)),
            pendingPermission.completion.then((result) => ({ type: "permission", result } as const)),
          ])

    if (next.type === "permission") {
      if (pendingPermission?.requestId === next.result.requestId) {
        pendingPermission = null
        input.setActivePermissionPrompt(null)
      }

      if (next.result.error) {
        throw next.result.error
      }

      if (!next.result.sent && input.getExitRequested()) {
        return {
          terminalStatus,
          terminalError,
          exitedWhileBlocked: true,
        }
      }

      continue
    }

    if (next.result.done) {
      break
    }

    const event = next.result.value
    if (!isActiveRunEvent(event, input.runId)) {
      continue
    }

    input.renderer.renderEvent(event)

    if (event.type === "permission.requested") {
      if (pendingPermission) {
        throw new Error(`Run ${input.runId} received overlapping permission requests`)
      }

      pendingPermission = startPendingPermissionReply(event, input.client, input.io)
      input.setActivePermissionPrompt(pendingPermission)
    }

    const terminal = extractTerminalRunStatus(event)
    if (terminal.status) {
      terminalStatus = terminal.status
      terminalError = terminal.error
      pendingPermission?.controller.abort()
      pendingPermission = null
      input.setActivePermissionPrompt(null)
      break
    }
  }

  pendingPermission?.controller.abort()
  input.setActivePermissionPrompt(null)

  return {
    terminalStatus,
    terminalError,
    exitedWhileBlocked: false,
  }
}

async function selectResumeSession(input: {
  client: AgentServerClient
  io: CliIO
  workspaceRoot: string
}) {
  const sessions = await listResumeSessions(input.client, input.workspaceRoot)
  if (sessions.length === 0) {
    input.io.write("session> no sessions found in this workspace\n")
    return null
  }

  const selection = await input.io.select?.(
    "Resume a session",
    sessions.map((session) => ({
      label: session.title,
      description: buildSessionResumeDescription(session),
    })),
  )

  if (selection == null) {
    return null
  }

  return sessions[selection] ?? null
}

async function listResumeSessions(client: AgentServerClient, workspaceRoot: string) {
  const sessions = await client.listSessions()

  return sessions
    .filter((session) => session.workspaceRoot === workspaceRoot)
    .sort((left, right) => {
      return (
        right.updatedAt - left.updatedAt ||
        right.createdAt - left.createdAt ||
        left.id.localeCompare(right.id)
      )
    })
}

function buildSessionResumeDescription(session: StoredSession) {
  const preview = session.latestUserMessagePreview ?? "(no user message yet)"
  return `${preview} | ${formatSessionActivityTime(session.updatedAt)}`
}

function formatSessionActivityTime(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")
}

function isIgnorableCancelError(error: unknown) {
  return error instanceof AgentServerClientError && error.code === "invalid_state"
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function isActiveRunEvent(event: ServerEvent, runId: string) {
  switch (event.type) {
    case "heartbeat":
    case "session.created":
    case "session.updated":
      return false
    case "run.created":
    case "run.updated":
      return event.run.id === runId
    case "message.created":
      return event.message.runId === runId
    case "message.part.updated":
      return event.part.runId === runId
    case "permission.requested":
    case "permission.updated":
      return event.permissionRequest.runId === runId
    case "runtime.error":
      return event.runId === runId
  }
}

function extractTerminalRunStatus(event: ServerEvent) {
  if (event.type !== "run.updated" || !isTerminalRunStatus(event.run.status)) {
    return {
      status: null,
      error: null,
    } as const
  }

  return {
    status: event.run.status,
    error: event.run.errorText,
  } as const
}
