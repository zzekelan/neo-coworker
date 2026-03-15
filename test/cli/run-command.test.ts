import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Provider, ProviderEvent, ProviderTurnRequest } from "../../src/providers/types"
import { runCli } from "../../src/cli/run-command"
import { createAgentServerClient } from "../../src/cli/server-client"
import { createAgentServer } from "../../src/server"
import {
  createConversationRepository as createStorageRepository,
  openConversationDatabase as openStorageDatabase,
} from "../../src/conversation/repo"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []
const activeServers: Array<{ stop(): Promise<void> | void }> = []

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.stop()
  }

  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("run command", () => {
  test("creates a session and completes a simple run through the server client", async () => {
    const harness = await createHarness("cli-run-simple", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Hello " }
        await Bun.sleep(10)
        yield { type: "text.delta", text: "from the server." }
      },
    ]))
    const output: string[] = []

    await runCli({
      argv: ["run", "Say hello"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output),
    })

    const sessions = harness.repository.sessions.list()
    const runs = harness.repository.runs.listBySession(sessions[0]!.id)

    expect(sessions).toHaveLength(1)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      sessionId: sessions[0]!.id,
      status: "completed",
      trigger: "cli",
    })
    expect(output.join("")).toContain(`session.created ${sessions[0]!.id}`)
    expect(output.join("")).toContain(`run.started ${runs[0]!.id}`)
    expect(output.join("")).toContain("Hello from the server.")
    expect(output.join("")).toContain(`run.completed ${runs[0]!.id}`)
  })

  test("continues an existing session and creates the next run in that session", async () => {
    const harness = await createHarness("cli-run-continue", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "First reply." }
      },
      async function* () {
        yield { type: "text.delta", text: "Second reply." }
      },
    ]))

    await runCli({
      argv: ["run", "First prompt"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(),
    })

    const sessionId = harness.repository.sessions.list()[0]!.id
    const output: string[] = []

    await runCli({
      argv: ["run", "--session", sessionId, "Second prompt"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output),
    })

    const runs = harness.repository.runs.listBySession(sessionId)
    const transcript = harness.repository.messages.listSessionTranscript(sessionId)

    expect(runs).toHaveLength(2)
    expect(runs.map((run) => run.status)).toEqual(["completed", "completed"])
    expect(transcript.filter((message) => message.role === "user").map((message) => message.parts[0]?.text))
      .toEqual(["First prompt", "Second prompt"])
    expect(output.join("")).toContain(`session.selected ${sessionId}`)
    expect(output.join("")).toContain(`run.started ${runs[1]!.id}`)
    expect(output.join("")).toContain("Second reply.")
    expect(output.join("")).toContain(`run.completed ${runs[1]!.id}`)
  })

  test("answers permission prompts through the server API and resumes the run", async () => {
    const harness = await createHarness(
      "cli-run-permission",
      createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello from cli"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Write finished." }
        },
      ]),
      {
        permissionPolicy: {
          write: "ask",
        },
      },
    )
    const output: string[] = []

    await runCli({
      argv: ["run", "Write notes.txt"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, ["y"]),
    })

    const sessionId = harness.repository.sessions.list()[0]!.id
    const run = harness.repository.runs.listBySession(sessionId)[0]!
    const permissionRequests = harness.repository.permissionRequests.listByRun(run.id)

    expect(permissionRequests).toMatchObject([
      {
        runId: run.id,
        status: "approved",
        toolName: "write",
      },
    ])
    expect(await readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).toBe("hello from cli")
    expect(output.join("")).toContain("permission.requested write write notes.txt")
    expect(output.join("")).toContain("tool.call write:")
    expect(output.join("")).toContain("tool.call.completed write: Wrote notes.txt")
    expect(output.join("")).toContain("Write finished.")
    expect(countOccurrences(output.join(""), "run.started")).toBe(1)
  })

  test("cancels and exits while a permission prompt is still waiting for input", async () => {
    const harness = await createHarness(
      "cli-run-permission-cancel",
      createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello from cli"}',
          }
        },
      ]),
      {
        permissionPolicy: {
          write: "ask",
        },
      },
    )
    const output: string[] = []
    let sigintHandler: (() => void) | undefined
    let releasePermissionRequested!: () => void
    const permissionRequested = new Promise<void>((resolve) => {
      releasePermissionRequested = resolve
    })

    const runPromise = runCli({
      argv: ["run", "Write notes.txt"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, [], {
        onWrite(text) {
          if (text.includes("permission.requested")) {
            releasePermissionRequested()
          }
        },
        onSigint(listener) {
          sigintHandler = listener
        },
        prompt() {
          return new Promise<string>(() => {})
        },
      }),
    })

    await permissionRequested
    expect(sigintHandler).toBeDefined()
    sigintHandler?.()

    const result = await Promise.race([
      runPromise.then(() => "completed"),
      Bun.sleep(500).then(() => "timed_out"),
    ])

    const sessionId = harness.repository.sessions.list()[0]!.id
    const run = harness.repository.runs.listBySession(sessionId)[0]!

    expect(result).toBe("completed")
    expect(run.status).toBe("cancelled")
    expect(output.join("")).toContain("permission.requested write write notes.txt")
    expect(output.join("")).toContain(`run.cancelled ${run.id}`)
  })

  test("cancels the active run through the server and exits after cancellation", async () => {
    const harness = await createHarness("cli-run-cancel", createTurnProvider([
      async function* (request) {
        yield { type: "text.delta", text: "Still working..." }
        await waitForAbort(request.signal)
      },
    ]))
    const output: string[] = []
    let sigintHandler: (() => void) | undefined
    let releaseStarted!: () => void
    const runStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve
    })

    const runPromise = runCli({
      argv: ["run", "Keep going"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, [], {
        onWrite(text) {
          if (text.includes("run.started")) {
            releaseStarted()
          }
        },
        onSigint(listener) {
          sigintHandler = listener
        },
      }),
    })

    await runStarted
    expect(sigintHandler).toBeDefined()
    sigintHandler?.()
    await runPromise

    const sessionId = harness.repository.sessions.list()[0]!.id
    const run = harness.repository.runs.listBySession(sessionId)[0]!

    expect(run.status).toBe("cancelled")
    expect(output.join("")).toContain("Still working...")
    expect(output.join("")).toContain(`run.cancelled ${run.id}`)
  })

  test("does not leave an unhandled rejection when SIGINT is received more than once", async () => {
    const harness = await createHarness("cli-run-double-cancel", createTurnProvider([
      async function* (request) {
        yield { type: "text.delta", text: "Still working..." }
        await waitForAbort(request.signal)
      },
    ]))
    const output: string[] = []
    const unhandledRejections: string[] = []
    const handleUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason instanceof Error ? reason.message : String(reason))
    }
    let sigintHandler: (() => void) | undefined
    let releaseStarted!: () => void
    const runStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve
    })

    process.on("unhandledRejection", handleUnhandledRejection)

    try {
      const runPromise = runCli({
        argv: ["run", "Keep going"],
        cwd: harness.workspaceRoot,
        workspaceRoot: harness.workspaceRoot,
        client: harness.client,
        io: createIo(output, [], {
          onWrite(text) {
            if (text.includes("run.started")) {
              releaseStarted()
            }
          },
          onSigint(listener) {
            sigintHandler = listener
          },
        }),
      })

      await runStarted
      sigintHandler?.()
      sigintHandler?.()
      await runPromise
      await Bun.sleep(0)
    } finally {
      process.off("unhandledRejection", handleUnhandledRejection)
    }

    expect(unhandledRejections).toEqual([])
    expect(output.join("")).toContain("Still working...")
    expect(countOccurrences(output.join(""), "run.cancelled")).toBe(1)
  })

  test("exits cleanly once the run reaches a terminal state", async () => {
    const harness = await createHarness("cli-run-terminal", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Done." }
      },
    ]))

    const result = await Promise.race([
      runCli({
        argv: ["run", "Finish now"],
        cwd: harness.workspaceRoot,
        workspaceRoot: harness.workspaceRoot,
        client: harness.client,
        io: createIo(),
      }).then(() => "completed"),
      Bun.sleep(500).then(() => "timed_out"),
    ])

    expect(result).toBe("completed")
  })
})

async function createHarness(
  prefix: string,
  provider: Provider,
  options: {
    permissionPolicy?: Partial<Record<"write" | "edit" | "shell", "allow" | "ask" | "deny">>
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  await mkdir(workspaceRoot, { recursive: true })
  await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

  const database = openStorageDatabase(join(directory, "agent.sqlite"))
  openDatabases.push(database)

  const repository = createStorageRepository({
    database,
  })
  const server = createAgentServer({
    provider,
    repository,
    heartbeatIntervalMs: 15,
    permissionPolicy: options.permissionPolicy,
  })
  activeServers.push(server)

  return {
    workspaceRoot,
    repository,
    client: createAgentServerClient({
      send(request) {
        return server.fetch(request)
      },
      origin: "http://server.test",
    }),
  }
}

function createIo(
  output: string[] = [],
  promptAnswers: string[] = [],
  hooks: {
    onWrite?(text: string): void
    onSigint?(listener: () => void): void
    prompt?(message: string, options?: { signal?: AbortSignal }): Promise<string>
  } = {},
) {
  return {
    write(text: string) {
      output.push(text)
      hooks.onWrite?.(text)
    },
    async prompt(message: string, options?: { signal?: AbortSignal }) {
      if (hooks.prompt) {
        return hooks.prompt(message, options)
      }

      return promptAnswers.shift() ?? "y"
    },
    onSigint(listener: () => void) {
      hooks.onSigint?.(listener)
    },
  }
}

function createTurnProvider(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
): Provider {
  let index = 0

  return {
    async *streamTurn(request: ProviderTurnRequest) {
      const turn = turns[index]
      index += 1

      if (!turn) {
        throw new Error(`Unexpected provider turn ${index}`)
      }

      for await (const event of turn(request)) {
        yield event
      }
    },
  }
}

async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) {
    return
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

function countOccurrences(text: string, token: string) {
  return text.split(token).length - 1
}
