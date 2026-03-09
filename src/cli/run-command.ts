import { isTerminalRunStatus } from "../run"
import type { Provider } from "../providers/types"
import type { PermissionDecision } from "../runtime/permissions"
import type { ServerEvent } from "../server/events"
import type { CliIO } from "./io"
import { createCliRenderState, renderServerEvent } from "./render"
import {
  AgentServerClientError,
  createLocalCliServerClient,
  type AgentServerClient,
  type CliServerClientHandle,
} from "./server-client"

export type RunCommand = {
  command: "run"
  prompt: string
  sessionId?: string
}

export function parseRunCommand(argv: string[]): RunCommand {
  const [command, ...rest] = argv

  if (command !== "run") {
    throw new Error("Only `run` is supported in MVP")
  }

  let sessionId: string | undefined
  const promptParts: string[] = []
  let parsingOptions = true

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]

    if (!argument) {
      continue
    }

    if (parsingOptions && argument === "--") {
      parsingOptions = false
      continue
    }

    if (parsingOptions && argument === "--session") {
      const value = rest[index + 1]
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

    parsingOptions = false
    promptParts.push(argument)
  }

  if (promptParts.length === 0) {
    throw new Error("A prompt is required")
  }

  return {
    command,
    prompt: promptParts.join(" "),
    sessionId,
  }
}

export type RunCliInput = {
  argv: string[]
  io: CliIO
  cwd?: string
  workspaceRoot?: string
  client?: AgentServerClient
  provider?: Provider
}

function getPermissionDecision(answer: string): PermissionDecision {
  const normalized = answer.trim().toLowerCase()
  return normalized === "y" || normalized === "yes" ? "allow" : "deny"
}

type PermissionRequestedServerEvent = {
  id: string
  time: number
  type: "permission.requested"
  permissionRequest: {
    id: string
    reason: string
  }
}

async function handlePermissionEvent(
  event: PermissionRequestedServerEvent,
  client: AgentServerClient,
  io: CliIO,
) {
  const answer = await io.prompt(`Allow ${event.permissionRequest.reason}? [y/N] `)

  await client.replyPermission({
    requestId: event.permissionRequest.id,
    decision: getPermissionDecision(answer),
  })
}

async function resolveClient(input: RunCliInput, workspaceRoot: string): Promise<CliServerClientHandle> {
  if (input.client) {
    return {
      client: input.client,
      async close() {},
    }
  }

  if (input.provider) {
    return createLocalCliServerClient({
      provider: input.provider,
      workspaceRoot,
    })
  }

  throw new Error("runCli requires either a server client or provider")
}

export async function runCli(input: RunCliInput) {
  const command = parseRunCommand(input.argv)
  const cwd = input.cwd ?? process.cwd()
  const workspaceRoot = input.workspaceRoot ?? cwd
  const clientHandle = await resolveClient(input, workspaceRoot)
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
      await clientHandle.client.cancelRun(runId)
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
      command.sessionId ??
      (await clientHandle.client.createSession({
        directory: cwd,
        workspaceRoot,
      })).id

    if (!command.sessionId) {
      input.io.write(`session.created ${sessionId}\n`)
    }

    const subscription = await clientHandle.client.subscribe()

    try {
      const started = await clientHandle.client.startRun({
        sessionId,
        prompt: command.prompt,
        trigger: "cli",
      })
      activeRunId = started.run.id
      cancelDispatched = false
      cancelError = null

      if (command.sessionId) {
        input.io.write(`session.selected ${sessionId}\n`)
      }

      if (cancelRequested) {
        cancelRequested = false
        await requestCancel(activeRunId)
      }

      let terminalStatus: ReturnType<typeof extractTerminalRunStatus>["status"] = null
      let terminalError: string | null = null

      for await (const event of subscription.events) {
        if (!isActiveRunEvent(event, activeRunId)) {
          continue
        }

        const rendered = renderServerEvent(renderState, event)
        if (rendered) {
          input.io.write(rendered)
        }

        if (event.type === "permission.requested") {
          await handlePermissionEvent(event, clientHandle.client, input.io)
        }

        const terminal = extractTerminalRunStatus(event)
        if (terminal.status) {
          terminalStatus = terminal.status
          terminalError = terminal.error
          break
        }
      }

      if (terminalStatus == null) {
        const currentRun = await clientHandle.client.getRun(activeRunId)

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
    await clientHandle.close()
    input.io.close?.()
  }
}

function isIgnorableCancelError(error: unknown) {
  return error instanceof AgentServerClientError && error.code === "invalid_state"
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
