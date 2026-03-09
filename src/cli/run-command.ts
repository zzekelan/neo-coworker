import type { Provider } from "../providers/types"
import type { RuntimeEvent } from "../runtime/events"
import type { PermissionDecision } from "../runtime/permissions"
import type { RunHandle } from "../runtime/run-handle"
import { createRuntime } from "../runtime/runtime"
import type { CliIO } from "./io"
import { renderEvent } from "./render"

export type RunCommand = {
  command: "run"
  prompt: string
}

export function parseRunCommand(argv: string[]): RunCommand {
  const [command, ...rest] = argv

  if (command !== "run") {
    throw new Error("Only `run` is supported in MVP")
  }

  return {
    command,
    prompt: rest.join(" "),
  }
}

type RuntimeLike = {
  run(input: { prompt: string; cwd: string; workspaceRoot: string }): Promise<RunHandle>
}

export type RunCliInput = {
  argv: string[]
  io: CliIO
  cwd?: string
  workspaceRoot?: string
  runtime?: RuntimeLike
  provider?: Provider
}

function getPermissionDecision(answer: string): PermissionDecision {
  const normalized = answer.trim().toLowerCase()
  return normalized === "y" || normalized === "yes" ? "allow" : "deny"
}

async function handlePermissionEvent(
  event: Extract<RuntimeEvent, { type: "permission.requested" }>,
  handle: RunHandle,
  io: CliIO,
) {
  const answer = await io.prompt(`Allow ${event.reason}? [y/N] `)

  await handle.respondPermission({
    requestId: event.requestId,
    decision: getPermissionDecision(answer),
  })
}

function resolveRuntime(input: RunCliInput): RuntimeLike {
  if (input.runtime) {
    return input.runtime
  }

  if (input.provider) {
    return createRuntime({ provider: input.provider })
  }

  throw new Error("runCli requires either a runtime or provider")
}

export async function runCli(input: RunCliInput) {
  const command = parseRunCommand(input.argv)
  const cwd = input.cwd ?? process.cwd()
  const workspaceRoot = input.workspaceRoot ?? cwd
  const runtime = resolveRuntime(input)
  const handle = await runtime.run({
    prompt: command.prompt,
    cwd,
    workspaceRoot,
  })
  const cleanupSigint =
    input.io.onSigint?.(() => {
      void handle.cancel()
    }) ?? undefined

  try {
    for await (const event of handle.events) {
      input.io.write(renderEvent(event))

      if (event.type === "permission.requested") {
        await handlePermissionEvent(event, handle, input.io)
      }
    }
  } finally {
    cleanupSigint?.()
    input.io.close?.()
  }
}
