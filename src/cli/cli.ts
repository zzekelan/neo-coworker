import {
  createPermissionAllowlistStore,
  createSessionInsightsAdapter,
  type AddAllowlistEntryInput,
  type AllowlistEntry,
  type InsightsPort,
  isTerminalRunStatus,
  type OrchestrationModelPort,
  type PermissionDecision,
  SessionAlreadyCompactingError,
  SessionBusyError,
  type SessionDatabase,
  type ServerEvent,
  type StoredPermissionRequest,
  type StoredSession,
} from "../bootstrap"
import type { CliIO } from "./cli-io"
import { createCliChatRenderer } from "./chat-render"
import { DEFAULT_CLI_INSIGHTS_LIMIT, formatSessionInsightsReport } from "./insights"
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
  agent?: string
}

export type ChatCommand = {
  command: "chat"
  sessionId?: string
  agent?: string
}

export type InsightsCommand = {
  command: "insights"
  sessionId?: string
}

export type PermissionsAllowlistCommand = {
  command: "permissions"
  scope: "allowlist"
  action: "add" | "remove" | "list"
  toolName?: string
  pattern?: string
  reason?: string
}

export type CliCommand = RunCommand | ChatCommand | InsightsCommand | PermissionsAllowlistCommand

const CLI_USAGE = [
  "Usage:",
  "  ncoworker run [--session <id>] [--agent <name>] <prompt>",
  "  ncoworker chat [--session <id>] [--agent <name>]",
  "  ncoworker insights [--session <id>]",
  "  ncoworker permissions allowlist <add|remove|list> ...",
  "",
  "Options:",
  "  --session <id>  Reuse an existing session",
  "  --agent <name>  Start runs with the specified agent",
].join("\n")

export function getCliUsage() {
  return `${CLI_USAGE}\n`
}

export function parseCliCommand(argv: string[]): CliCommand {
  const [command, ...rest] = argv

  if (command === "help" || command === "--help" || command === "-h") {
    throw new Error(getCliUsage().trimEnd())
  }

  if (command === "run") {
    const parsed = parseCommandOptions(rest, {
      allowAgent: true,
    })
    if (parsed.positionals.length === 0) {
      throw new Error("A prompt is required")
    }

    return {
      command,
      prompt: parsed.positionals.join(" "),
      sessionId: parsed.sessionId,
      agent: parsed.agent,
    }
  }

  if (command === "chat") {
    const parsed = parseCommandOptions(rest, {
      allowPayload: false,
      commandName: "chat",
      allowAgent: true,
    })

    if (parsed.positionals.length > 0) {
      throw new Error("`chat` does not accept a prompt")
    }

    return {
      command,
      sessionId: parsed.sessionId,
      agent: parsed.agent,
    }
  }

  if (command === "insights") {
    const parsed = parseCommandOptions(rest, {
      allowPayload: false,
      commandName: "insights",
    })

    if (parsed.positionals.length > 0) {
      throw new Error("`insights` does not accept extra arguments")
    }

    return {
      command,
      sessionId: parsed.sessionId,
    }
  }

  if (command === "permissions") {
    return parsePermissionsCommand(rest)
  }

  throw new Error("Only `run`, `chat`, `insights`, and `permissions` are supported")
}

function parsePermissionsCommand(argv: string[]): PermissionsAllowlistCommand {
  const [scope, action, ...rest] = argv

  if (scope !== "allowlist") {
    throw new Error("`permissions` only supports the `allowlist` scope")
  }

  if (action !== "add" && action !== "remove" && action !== "list") {
    throw new Error("`permissions allowlist` requires `add`, `remove`, or `list`")
  }

  if (action === "list") {
    if (rest.length > 0) {
      throw new Error("`permissions allowlist list` does not accept extra arguments")
    }

    return { command: "permissions", scope, action }
  }

  if (action === "remove") {
    if (rest.length !== 1) {
      throw new Error("`permissions allowlist remove` requires exactly one pattern")
    }

    return { command: "permissions", scope, action, pattern: rest[0] }
  }

  if (rest.length < 2) {
    throw new Error("`permissions allowlist add` requires <toolName> <pattern> [reason]")
  }

  return {
    command: "permissions",
    scope,
    action,
    toolName: rest[0],
    pattern: rest[1],
    reason: rest.slice(2).join(" ") || undefined,
  }
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
    commandName?: string
    allowAgent?: boolean
  } = {},
) {
  const allowPayload = options.allowPayload ?? true
  const commandName = options.commandName ?? "command"
  const allowAgent = options.allowAgent ?? false
  let sessionId: string | undefined
  let agent: string | undefined
  const positionals: string[] = []
  let parsingOptions = true

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (!argument) {
      continue
    }

    if (parsingOptions && argument === "--") {
      if (!allowPayload) {
        throw new Error(`\`${commandName}\` does not accept \`--\``)
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

    if (parsingOptions && argument === "--agent") {
      if (!allowAgent) {
        throw new Error(`\`${commandName}\` does not accept \`--agent\``)
      }

      const value = argv[index + 1]
      if (!value) {
        throw new Error("--agent requires a value")
      }

      agent = value
      index += 1
      continue
    }

    if (parsingOptions && argument.startsWith("--agent=")) {
      if (!allowAgent) {
        throw new Error(`\`${commandName}\` does not accept \`--agent\``)
      }

      const value = argument.slice("--agent=".length)
      if (!value) {
        throw new Error("--agent requires a value")
      }

      agent = value
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
    agent,
    positionals,
  }
}

type LocalCliStorageHandle = Omit<
  Pick<Parameters<typeof createLocalCliServerClient>[0], "repository" | "permissionRepository" | "closeImpl">,
  "closeImpl"
> & {
  closeImpl: NonNullable<Parameters<typeof createLocalCliServerClient>[0]["closeImpl"]>
  database?: SessionDatabase | null
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
  createLocalStorageImpl: (workspaceRoot: string) => LocalCliStorageHandle | Promise<LocalCliStorageHandle>
}

type RunCliInsightsInput = {
  client?: never
  provider?: never
  createLocalCliServerClientImpl?: never
  createLocalRuntimeImpl?: never
  createLocalStorageImpl: (workspaceRoot: string) => LocalCliStorageHandle | Promise<LocalCliStorageHandle>
}

export type RunCliInput = {
  argv: string[]
  io: CliIO
  cwd?: string
  workspaceRoot?: string
} & (RunCliClientInput | RunCliProviderInput | RunCliInsightsInput)

type PendingPermissionReply = {
  requestId: string
  controller: AbortController
  completion: Promise<{
    requestId: string
    error: unknown | null
    sent: boolean
  }>
}

type PendingPermissionQueue = {
  active: PendingPermissionReply | null
  queued: PermissionRequestedServerEvent[]
}

type NextCliRunLoopResult =
  | {
      type: "event"
      result: IteratorResult<ServerEvent>
    }
  | {
      type: "permission"
      result: Awaited<PendingPermissionReply["completion"]>
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

function comparePermissionRequests(
  left: Pick<StoredPermissionRequest, "createdAt" | "id">,
  right: Pick<StoredPermissionRequest, "createdAt" | "id">,
) {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

function comparePermissionEvents(
  left: PermissionRequestedServerEvent,
  right: PermissionRequestedServerEvent,
) {
  return comparePermissionRequests(left.permissionRequest, right.permissionRequest)
}

function createResumePermissionRequestedEvent(
  request: StoredPermissionRequest,
): PermissionRequestedServerEvent {
  return {
    id: `permission_resume_${request.id}`,
    time: request.createdAt,
    type: "permission.requested",
    permissionRequest: request,
  }
}

function enqueuePendingPermissionEvent(
  queue: PendingPermissionQueue,
  event: PermissionRequestedServerEvent,
) {
  const requestId = event.permissionRequest.id
  if (
    queue.active?.requestId === requestId ||
    queue.queued.some((candidate) => candidate.permissionRequest.id === requestId)
  ) {
    return
  }

  queue.queued.push(event)
  queue.queued.sort(comparePermissionEvents)
}

function startNextPendingPermissionReply(input: {
  queue: PendingPermissionQueue
  client: AgentServerClient
  io: CliIO
  onActivePermissionChange?: (value: PendingPermissionReply | null) => void
}) {
  if (input.queue.active || input.queue.queued.length === 0) {
    return input.queue.active
  }

  input.queue.active = startPendingPermissionReply(input.queue.queued.shift()!, input.client, input.io)
  input.onActivePermissionChange?.(input.queue.active)
  return input.queue.active
}

function clearPendingPermissionQueue(
  queue: PendingPermissionQueue,
  onActivePermissionChange?: (value: PendingPermissionReply | null) => void,
) {
  queue.active?.controller.abort()
  queue.active = null
  queue.queued.length = 0
  onActivePermissionChange?.(null)
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

async function resolveInsightsPort(
  input: RunCliInput,
  workspaceRoot: string,
): Promise<{
  insights: InsightsPort
  close(): Promise<void> | void
}> {
  if (!("createLocalStorageImpl" in input) || !input.createLocalStorageImpl) {
    throw new Error("Insights requires local storage composition")
  }

  const localStorage = await input.createLocalStorageImpl(workspaceRoot)

  if (!localStorage.database) {
    await localStorage.closeImpl()
    throw new Error("Insights requires a local session database")
  }

  return {
    insights: createSessionInsightsAdapter({
      database: localStorage.database,
    }),
    close() {
      return localStorage.closeImpl()
    },
  }
}

async function resolvePermissionAllowlistHandle(input: RunCliInput, workspaceRoot: string) {
  if (!("createLocalStorageImpl" in input) || !input.createLocalStorageImpl) {
    throw new Error("Permission allowlist commands require local storage composition")
  }

  const localStorage = await input.createLocalStorageImpl(workspaceRoot)

  if (!localStorage.database) {
    await localStorage.closeImpl()
    throw new Error("Permission allowlist commands require a local session database")
  }

  return {
    allowlist: createPermissionAllowlistStore({
      database: localStorage.database,
      workspaceRoot,
    }),
    close() {
      return localStorage.closeImpl()
    },
  }
}

export async function runCli(input: RunCliInput) {
  const command = parseCliCommand(input.argv)
  const cwd = input.cwd ?? process.cwd()
  const workspaceRoot = input.workspaceRoot ?? cwd

  if (command.command === "insights") {
    const insightsHandle = await resolveInsightsPort(input, workspaceRoot)

    try {
      await runInsightsCli({
        command,
        io: input.io,
        insights: insightsHandle.insights,
      })
    } finally {
      await insightsHandle.close()
      input.io.close?.()
    }

    return
  }

  if (command.command === "permissions") {
    const allowlistHandle = await resolvePermissionAllowlistHandle(input, workspaceRoot)

    try {
      await runPermissionAllowlistCli({
        command,
        io: input.io,
        allowlist: allowlistHandle.allowlist,
      })
    } finally {
      await allowlistHandle.close()
      input.io.close?.()
    }

    return
  }

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

async function runInsightsCli(input: {
  command: InsightsCommand
  io: CliIO
  insights: InsightsPort
}) {
  const insights = await input.insights.querySessions(
    input.command.sessionId
      ? {
          sessionIds: [input.command.sessionId],
          limit: 1,
        }
      : {
          limit: DEFAULT_CLI_INSIGHTS_LIMIT,
        },
  )

  const summary = input.insights.summarize(insights)
  input.io.write(
    formatSessionInsightsReport({
      insights,
      summary,
    }),
  )
}

async function runPermissionAllowlistCli(input: {
  command: PermissionsAllowlistCommand
  io: CliIO
  allowlist: {
    add(entry: AddAllowlistEntryInput): Promise<AllowlistEntry>
    remove(pattern: string): Promise<number>
    list(): Promise<AllowlistEntry[]>
  }
}) {
  if (input.command.action === "list") {
    const entries = await input.allowlist.list()
    if (entries.length === 0) {
      input.io.write("No allowlist entries configured.\n")
      return
    }

    input.io.write(entries.map((entry) => {
      const reason = entry.reason ? ` (${entry.reason})` : ""
      return `${entry.toolName} ${entry.pattern}${reason}`
    }).join("\n") + "\n")
    return
  }

  if (input.command.action === "remove") {
    const removed = await input.allowlist.remove(input.command.pattern!)
    input.io.write(`Removed ${removed} allowlist entr${removed === 1 ? "y" : "ies"}.\n`)
    return
  }

  const entry = await input.allowlist.add({
    toolName: input.command.toolName!,
    pattern: input.command.pattern!,
    reason: input.command.reason,
  })
  input.io.write(`Added allowlist entry for ${entry.toolName} ${entry.pattern}.\n`)
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
        ...(input.command.agent === undefined ? {} : { agent: input.command.agent }),
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
      const pendingPermissionQueue: PendingPermissionQueue = {
        active: null,
        queued: [],
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
        const next: NextCliRunLoopResult =
          pendingPermissionQueue.active == null
            ? ({ type: "event", result: await readNextEvent() } as const)
            : await Promise.race([
                readNextEvent().then((result) => ({ type: "event", result } as const)),
                pendingPermissionQueue.active.completion.then((result) => ({
                  type: "permission",
                  result,
                }) as const),
              ])

        if (next.type === "permission") {
          if (pendingPermissionQueue.active?.requestId === next.result.requestId) {
            pendingPermissionQueue.active = null
          }

          if (next.result.error) {
            throw next.result.error
          }

          startNextPendingPermissionReply({
            queue: pendingPermissionQueue,
            client: input.clientHandle.client,
            io: input.io,
          })

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
          enqueuePendingPermissionEvent(pendingPermissionQueue, event)
          startNextPendingPermissionReply({
            queue: pendingPermissionQueue,
            client: input.clientHandle.client,
            io: input.io,
          })
        }

        const terminal = extractTerminalRunStatus(event)
        if (terminal.status) {
          terminalStatus = terminal.status
          terminalError = terminal.error
          clearPendingPermissionQueue(pendingPermissionQueue)
          break
        }
      }

      clearPendingPermissionQueue(pendingPermissionQueue)

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
  let shouldRestoreSession = currentSessionId != null
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
      if (currentSessionId && shouldRestoreSession) {
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
        shouldRestoreSession = false

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
          shouldRestoreSession = true
          input.io.write(`session> ${selectedSession.title}\n`)
        }

        continue
      }

      if (trimmed === "/compact") {
        if (!currentSessionId) {
          input.io.write("status> no session to compact\n")
          continue
        }

        try {
          const compactResult = await runCompactCommand({
            client: input.clientHandle.client,
            io: input.io,
            workspaceRoot: input.workspaceRoot,
            sessionId: currentSessionId,
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

          if (compactResult === "exit") {
            break
          }
        } catch (error) {
          if (!isRecoverableCommandError(error)) {
            throw error
          }

          input.io.write(`error> ${error.message}\n`)
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
        shouldRestoreSession = false
      }

      const runResult = await runChatTurn({
        client: input.clientHandle.client,
        io: input.io,
        workspaceRoot: input.workspaceRoot,
        sessionId: currentSessionId,
        prompt: promptText,
        agent: input.command.agent,
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
  agent?: string
  getExitRequested(): boolean
  setActivePermissionPrompt(value: PendingPermissionReply | null): void
  setActiveRunId(value: string | null): void
}) {
  const renderer = createCliChatRenderer({
    io: input.io,
    workspaceRoot: input.workspaceRoot,
  })

  const subscription = await input.client.subscribe()

  try {
    const started = await input.client.startRun({
      sessionId: input.sessionId,
      prompt: input.prompt,
      trigger: "cli",
      ...(input.agent === undefined ? {} : { agent: input.agent }),
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

async function runCompactCommand(input: {
  client: AgentServerClient
  io: CliIO
  workspaceRoot: string
  sessionId: string
  getExitRequested(): boolean
  setActivePermissionPrompt(value: PendingPermissionReply | null): void
  setActiveRunId(value: string | null): void
}) {
  const renderer = createCliChatRenderer({
    io: input.io,
    workspaceRoot: input.workspaceRoot,
  })

  const subscription = await input.client.subscribe()

  try {
    const started = await input.client.compactSession(input.sessionId)
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
    const timeline = await input.client.listSessionTimeline(input.sessionId)
    const renderer = createCliChatRenderer({
      io: input.io,
      workspaceRoot: input.workspaceRoot,
    })

    renderer.hydrateTimeline({
      timeline,
    })
    renderer.finish()
    return "continue" as const
  }

  const runState = await input.client.getRun(activeRun.id)
  const pendingPermissions =
    activeRun.status === "waiting_permission"
      ? runState.permissionRequests
          .filter((request) => request.status === "pending")
          .sort(comparePermissionRequests)
      : []

  if (activeRun.status === "waiting_permission" && pendingPermissions.length === 0) {
    throw new Error(`Run ${activeRun.id} is waiting on permission but has no pending requests`)
  }

  const subscription = await input.client.subscribe()
  const renderer = createCliChatRenderer({
    io: input.io,
    workspaceRoot: input.workspaceRoot,
  })

  try {
    const timeline = await input.client.listSessionTimeline(input.sessionId)
    renderer.hydrateTimeline({
      timeline,
      activeRunId: activeRun.id,
      activeRunTrigger: activeRun.trigger,
      renderLiveActivity: activeRun.status === "running",
    })
    input.setActiveRunId(activeRun.id)

    const watched = await watchChatRun({
      client: input.client,
      io: input.io,
      runId: activeRun.id,
      subscription,
      renderer,
      getExitRequested: input.getExitRequested,
      setActivePermissionPrompt: input.setActivePermissionPrompt,
      initialPendingPermissionRequests: pendingPermissions,
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
  initialPendingPermissionRequests?: StoredPermissionRequest[]
}): Promise<WatchChatRunResult> {
  let terminalStatus: ReturnType<typeof extractTerminalRunStatus>["status"] = null
  let terminalError: string | null = null
  const eventIterator = input.subscription.events[Symbol.asyncIterator]()
  let nextEventPromise: Promise<IteratorResult<ServerEvent>> | null = null
  const pendingPermissionQueue: PendingPermissionQueue = {
    active: null,
    queued: (input.initialPendingPermissionRequests ?? [])
      .slice()
      .sort(comparePermissionRequests)
      .map(createResumePermissionRequestedEvent),
  }

  startNextPendingPermissionReply({
    queue: pendingPermissionQueue,
    client: input.client,
    io: input.io,
    onActivePermissionChange: input.setActivePermissionPrompt,
  })

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
      pendingPermissionQueue.active == null
        ? ({ type: "event", result: await readNextEvent() } as const)
        : await Promise.race([
            readNextEvent().then((result) => ({ type: "event", result } as const)),
            pendingPermissionQueue.active.completion.then((result) => ({
              type: "permission",
              result,
            }) as const),
          ])

    if (next.type === "permission") {
      if (pendingPermissionQueue.active?.requestId === next.result.requestId) {
        pendingPermissionQueue.active = null
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

      startNextPendingPermissionReply({
        queue: pendingPermissionQueue,
        client: input.client,
        io: input.io,
        onActivePermissionChange: input.setActivePermissionPrompt,
      })

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
      enqueuePendingPermissionEvent(pendingPermissionQueue, event)
      startNextPendingPermissionReply({
        queue: pendingPermissionQueue,
        client: input.client,
        io: input.io,
        onActivePermissionChange: input.setActivePermissionPrompt,
      })
    }

    const terminal = extractTerminalRunStatus(event)
    if (terminal.status) {
      terminalStatus = terminal.status
      terminalError = terminal.error
      clearPendingPermissionQueue(pendingPermissionQueue, input.setActivePermissionPrompt)
      break
    }
  }

  clearPendingPermissionQueue(pendingPermissionQueue, input.setActivePermissionPrompt)

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

function isRecoverableCommandError(error: unknown): error is Error {
  return (
    error instanceof SessionBusyError ||
    error instanceof SessionAlreadyCompactingError ||
    (error instanceof AgentServerClientError &&
      (error.code === "invalid_state" || error.code === "already_compacting"))
  )
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
