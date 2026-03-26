import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
  createModelProvider,
} from "../../src/model"
import type { OrchestrationModelPort } from "../../src/orchestration"
import { createPermissionRepository } from "../../src/permission"
import { createAgentServerClient, runCli } from "../../src/cli"
import { createAgentServer } from "../../src/app-server"
import { createCliStorageComposition, createRuntime } from "../../src/bootstrap"
import {
  createSessionRepository as createStorageRepository,
  openSessionDatabase as openStorageDatabase,
} from "../../src/session"

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
    const permissionRequests = harness.permissionRepository.requests.listByRun(run.id)

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

  test("cancels the run after a denied permission reply", async () => {
    const harness = await createHarness(
      "cli-run-permission-denied",
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
          yield { type: "text.delta", text: "This turn should not run." }
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
      io: createIo(output, ["n"]),
    })

    const sessionId = harness.repository.sessions.list()[0]!.id
    const run = harness.repository.runs.listBySession(sessionId)[0]!
    const permissionRequests = harness.permissionRepository.requests.listByRun(run.id)

    expect(permissionRequests).toMatchObject([
      {
        runId: run.id,
        status: "denied",
        toolName: "write",
      },
    ])
    expect(run.status).toBe("cancelled")
    expect(output.join("")).toContain("permission.requested write write notes.txt")
    expect(output.join("")).toContain("error Tool write failed: Permission denied")
    expect(output.join("")).toContain(`run.cancelled ${run.id}`)
    expect(output.join("")).not.toContain("This turn should not run.")
  })

  test("retries a transient provider timeout after permission approval and completes", async () => {
    let attempts = 0
    const harness = await createHarness("cli-run-provider-retry", {
      async *streamTurn() {
        attempts += 1

        if (attempts === 1) {
          yield {
            type: "tool.call",
            callId: "call_shell",
            name: "shell",
            inputText: '{"command":"pwd"}',
          }
          return
        }

        if (attempts < 4) {
          throw new Error("request timed out")
        }

        yield { type: "text.delta", text: "Recovered after retry." }
      },
    }, {
      permissionPolicy: {
        shell: "ask",
      },
    })
    const output: string[] = []

    await runCli({
      argv: ["run", "Print the current directory"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, ["y"]),
    })

    const sessionId = harness.repository.sessions.list()[0]!.id
    const run = harness.repository.runs.listBySession(sessionId)[0]!

    expect(attempts).toBe(4)
    expect(run.status).toBe("completed")
    expect(output.join("")).toContain("tool.call.completed shell:")
    expect(output.join("")).toContain("Recovered after retry.")
    expect(output.join("")).toContain(`run.completed ${run.id}`)
  })

  test("fails promptly after exhausting provider retries after permission approval", async () => {
    let attempts = 0
    const harness = await createHarness("cli-run-provider-timeout", {
      async *streamTurn() {
        attempts += 1

        if (attempts === 1) {
          yield {
            type: "tool.call",
            callId: "call_shell",
            name: "shell",
            inputText: '{"command":"pwd"}',
          }
          return
        }

        throw new Error("request timed out")
      },
    }, {
      permissionPolicy: {
        shell: "ask",
      },
    })
    const output: string[] = []

    const result = await Promise.race([
      runCli({
        argv: ["run", "Print the current directory"],
        cwd: harness.workspaceRoot,
        workspaceRoot: harness.workspaceRoot,
        client: harness.client,
        io: createIo(output, ["y"]),
      })
        .then(() => "completed")
        .catch((error) => (error instanceof Error ? error.message : String(error))),
      Bun.sleep(500).then(() => "timed_out"),
    ])

    const sessionId = harness.repository.sessions.list()[0]!.id
    const run = harness.repository.runs.listBySession(sessionId)[0]!

    expect(attempts).toBe(4)
    expect(result).toBe("request timed out")
    expect(run.status).toBe("failed")
    expect(run.errorText).toBe("request timed out")
    expect(output.join("")).toContain("tool.call.completed shell:")
    expect(output.join("")).toContain("run.failed request timed out")
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

  test("retries the same session after permission-time cancellation without replaying the stale tool call", async () => {
    let secondRunSawCancelledToolCall = false
    const harness = await createHarness(
      "cli-run-permission-cancel-retry",
      createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_first",
            name: "write",
            inputText: '{"path":"hello.ts","content":"console.log(\\"hello, world\\");"}',
          }
        },
        async function* (request) {
          secondRunSawCancelledToolCall = request.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.parts.some(
                (part) => part.type === "tool_call" && part.callId === "call_write_first",
              ),
          )

          yield {
            type: "tool.call",
            callId: "call_write_second",
            name: "write",
            inputText: '{"path":"hello.ts","content":"console.log(\\"hello, world\\");"}',
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
    const cancelledOutput: string[] = []
    let sigintHandler: (() => void) | undefined
    let releasePermissionRequested!: () => void
    const permissionRequested = new Promise<void>((resolve) => {
      releasePermissionRequested = resolve
    })

    const cancelledRun = runCli({
      argv: ["run", "Write hello.ts"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(cancelledOutput, [], {
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
    sigintHandler?.()
    await cancelledRun

    const sessionId = harness.repository.sessions.list()[0]!.id
    const retryOutput: string[] = []

    await runCli({
      argv: ["run", "--session", sessionId, "Write hello.ts"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(retryOutput, ["y"]),
    })

    const runs = harness.repository.runs.listBySession(sessionId)

    expect(secondRunSawCancelledToolCall).toBe(false)
    expect(runs.map((run) => run.status)).toEqual(["cancelled", "completed"])
    expect(
      harness.permissionRepository.requests.listByRun(runs[0]!.id).map((request) => request.status),
    ).toEqual(["cancelled"])
    expect(
      harness.permissionRepository.requests.listByRun(runs[1]!.id).map((request) => request.status),
    ).toEqual(["approved"])
    expect(await readFile(join(harness.workspaceRoot, "hello.ts"), "utf8")).toBe(
      'console.log("hello, world");',
    )
    expect(cancelledOutput.join("")).toContain("permission.requested write write hello.ts")
    expect(cancelledOutput.join("")).toContain(`run.cancelled ${runs[0]!.id}`)
    expect(retryOutput.join("")).toContain("permission.requested write write hello.ts")
    expect(retryOutput.join("")).toContain("tool.call.completed write: Wrote hello.ts")
    expect(retryOutput.join("")).toContain("Write finished.")
    expect(retryOutput.join("")).toContain(`run.completed ${runs[1]!.id}`)
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

  test("cancels the active run even when the provider ignores abort", async () => {
    const harness = await createHarness("cli-run-stalled-provider", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Still working..." }
        await new Promise<void>(() => {})
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
          if (text.includes("Still working...")) {
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

    const result = await Promise.race([
      runPromise.then(() => "completed"),
      Bun.sleep(500).then(() => "timed_out"),
    ])

    const sessionId = harness.repository.sessions.list()[0]!.id
    const run = harness.repository.runs.listBySession(sessionId)[0]!

    expect(result).toBe("completed")
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

describe("chat command", () => {
  test("keeps the process alive across multiple turns and exits on /exit", async () => {
    const harness = await createHarness("cli-chat-multi-turn", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "First reply." }
      },
      async function* () {
        yield { type: "text.delta", text: "Second reply." }
      },
    ]))
    const output: string[] = []

    await runCli({
      argv: ["chat"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, ["First prompt", "Second prompt", "/exit"]),
    })

    const sessions = harness.repository.sessions.list()
    const runs = harness.repository.runs.listBySession(sessions[0]!.id)

    expect(sessions).toHaveLength(1)
    expect(runs).toHaveLength(2)
    expect(runs.map((run) => run.status)).toEqual(["completed", "completed"])
    expect(
      harness.repository.messages.listSessionTranscript(sessions[0]!.id)
        .filter((message) => message.role === "user")
        .map((message) => message.parts[0]?.text),
    ).toEqual(["First prompt", "Second prompt"])
    const rendered = output.join("")

    expect(countOccurrences(rendered, "you> First prompt")).toBe(1)
    expect(rendered).toContain("assistant> First reply.")
    expect(countOccurrences(rendered, "you> Second prompt")).toBe(1)
    expect(rendered).toContain("assistant> Second reply.")
  })

  test("/resume only lists sessions in the current workspace and sorts by recent activity", async () => {
    const harness = await createHarness("cli-chat-resume-list", createTurnProvider([]))
    const otherWorkspaceRoot = join(dirname(harness.workspaceRoot), "other-workspace")
    await mkdir(otherWorkspaceRoot, { recursive: true })

    harness.repository.sessions.create({
      id: "session_old",
      directory: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      createdAt: 1,
      title: "Older session",
      updatedAt: 10,
      latestUserMessagePreview: "older preview",
    })
    harness.repository.sessions.create({
      id: "session_new",
      directory: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      createdAt: 2,
      title: "Newer session",
      updatedAt: 20,
      latestUserMessagePreview: "newer preview",
    })
    harness.repository.sessions.create({
      id: "session_other",
      directory: otherWorkspaceRoot,
      workspaceRoot: otherWorkspaceRoot,
      createdAt: 3,
      title: "Other workspace",
      updatedAt: 30,
      latestUserMessagePreview: "should be filtered",
    })

    const output: string[] = []
    let itemsSeen: Array<{ label: string; description?: string }> = []

    await runCli({
      argv: ["chat"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, ["/resume", "/exit"], {
        async select(_message, items) {
          itemsSeen = items
          return 1
        },
      }),
    })

    expect(itemsSeen).toEqual([
      {
        label: "Newer session",
        description: expect.stringContaining("newer preview"),
      },
      {
        label: "Older session",
        description: expect.stringContaining("older preview"),
      },
    ])
    expect(output.join("")).toContain("session> Older session")
  })

  test("replays prior visible dialogue when entering an idle session", async () => {
    const harness = await createHarness("cli-chat-resume-idle", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "First reply." }
      },
    ]))

    await runCli({
      argv: ["chat"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo([], ["First prompt", "/exit"]),
    })

    const sessionId = harness.repository.sessions.list()[0]!.id
    const output: string[] = []

    await runCli({
      argv: ["chat", "--session", sessionId],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, ["/exit"]),
    })

    const rendered = output.join("")

    expect(countOccurrences(rendered, "you> First prompt")).toBe(1)
    expect(countOccurrences(rendered, "assistant> First reply.")).toBe(1)
  })

  test("preserves a permission-blocked session across exit and later /resume", async () => {
    const harness = await createHarness(
      "cli-chat-resume-permission",
      createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello from chat"}',
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
    const firstOutput: string[] = []
    let sigintHandler: (() => void) | undefined
    let releasePermissionPrompt!: () => void
    const permissionPromptVisible = new Promise<void>((resolve) => {
      releasePermissionPrompt = resolve
    })

    const firstChat = runCli({
      argv: ["chat"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(firstOutput, ["Write notes.txt"], {
        onSigint(listener) {
          sigintHandler = listener
        },
        async prompt(message, options) {
          if (message.startsWith("permission>")) {
            releasePermissionPrompt()
            return new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" })),
                { once: true },
              )
            })
          }

          return "Write notes.txt"
        },
      }),
    })

    await permissionPromptVisible
    sigintHandler?.()
    await firstChat

    const sessionId = harness.repository.sessions.list()[0]!.id
    const firstRun = harness.repository.runs.listBySession(sessionId)[0]!

    expect(firstRun.status).toBe("waiting_permission")
    expect(harness.permissionRepository.requests.listByRun(firstRun.id)).toMatchObject([
      {
        status: "pending",
        toolName: "write",
      },
    ])
    expect(firstOutput.join("")).not.toContain("status> cancelled")

    const secondOutput: string[] = []
    const secondAnswers = ["/resume", "/exit"]

    await runCli({
      argv: ["chat"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(secondOutput, ["/resume", "/exit"], {
        async prompt(message) {
          if (message.startsWith("permission>")) {
            secondOutput.push(`${message}y\n`)
            return "y"
          }

          const answer = secondAnswers.shift() ?? "/exit"
          secondOutput.push(`${message}${answer}\n`)
          return answer
        },
        async select() {
          return 0
        },
      }),
    })

    expect(harness.repository.runs.get(firstRun.id).status).toBe("completed")
    expect(harness.permissionRepository.requests.listByRun(firstRun.id)).toMatchObject([
      {
        status: "approved",
      },
    ])
    expect(await readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).toBe("hello from chat")
    expect(secondOutput.join("")).toContain("assistant> Write finished.")
  })

  test("resumes an already-running session after assistant output has started", async () => {
    let releaseFirstDelta!: () => void
    const firstDeltaEmitted = new Promise<void>((resolve) => {
      releaseFirstDelta = resolve
    })
    let releaseContinuation!: () => void
    const continueRun = new Promise<void>((resolve) => {
      releaseContinuation = resolve
    })
    const harness = await createHarness("cli-chat-resume-active-run", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Hello " }
        releaseFirstDelta()
        await continueRun
        yield { type: "text.delta", text: "again." }
      },
    ]))
    const session = await harness.client.createSession({
      directory: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
    })

    await harness.client.startRun({
      sessionId: session.id,
      prompt: "Say hello",
      trigger: "cli",
    })
    await firstDeltaEmitted

    const output: string[] = []
    let releaseSubscribed!: () => void
    const subscribed = new Promise<void>((resolve) => {
      releaseSubscribed = resolve
    })
    const client = {
      ...harness.client,
      async subscribe() {
        const subscription = await harness.client.subscribe()
        releaseSubscribed()
        return subscription
      },
    }

    const chat = runCli({
      argv: ["chat", "--session", session.id],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client,
      io: createIo(output, ["/exit"]),
    })

    await subscribed
    releaseContinuation()
    await chat

    expect(output.join("")).toContain("assistant> Hello again.")
  })

  test("shows a thinking status before assistant text when no tool activity is visible", async () => {
    const harness = await createHarness("cli-chat-thinking-status", createTurnProvider([
      async function* () {
        await Bun.sleep(40)
        yield { type: "text.delta", text: "After thinking." }
      },
    ]))
    const output: string[] = []

    await runCli({
      argv: ["chat"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, ["Think first", "/exit"]),
    })

    const rendered = output.join("")

    expect(rendered).toContain("| thinking")
    expect(rendered).toContain("✓ thinking")
    expect(rendered).toContain("assistant> After thinking.")
    expect(rendered.indexOf("| thinking")).toBeLessThan(rendered.indexOf("assistant> After thinking."))
    expect(rendered.indexOf("✓ thinking")).toBeLessThan(rendered.indexOf("assistant> After thinking."))
  })

  test("ignores stale queued text snapshots when hydrating a resumed active run", async () => {
    let releaseFirstDelta!: () => void
    const allowFirstDelta = new Promise<void>((resolve) => {
      releaseFirstDelta = resolve
    })
    let releaseSecondDelta!: () => void
    const allowSecondDelta = new Promise<void>((resolve) => {
      releaseSecondDelta = resolve
    })
    let markFirstDeltaEmitted!: () => void
    const firstDeltaEmitted = new Promise<void>((resolve) => {
      markFirstDeltaEmitted = resolve
    })
    let markSecondDeltaEmitted!: () => void
    const secondDeltaEmitted = new Promise<void>((resolve) => {
      markSecondDeltaEmitted = resolve
    })
    const harness = await createHarness("cli-chat-resume-stale-delta", createTurnProvider([
      async function* () {
        await allowFirstDelta
        yield { type: "text.delta", text: "Hello " }
        markFirstDeltaEmitted()
        await allowSecondDelta
        yield { type: "text.delta", text: "again." }
        markSecondDeltaEmitted()
      },
    ]))
    const session = await harness.client.createSession({
      directory: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
    })

    await harness.client.startRun({
      sessionId: session.id,
      prompt: "Say hello",
      trigger: "cli",
    })

    const output: string[] = []
    const client = {
      ...harness.client,
      async subscribe() {
        const subscription = await harness.client.subscribe()
        releaseFirstDelta()
        await firstDeltaEmitted
        return subscription
      },
      async listSessionTranscript(sessionId: string) {
        releaseSecondDelta()
        await secondDeltaEmitted
        return harness.client.listSessionTranscript(sessionId)
      },
    }

    await runCli({
      argv: ["chat", "--session", session.id],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client,
      io: createIo(output, ["/exit"]),
    })

    expect(countOccurrences(output.join(""), "assistant> Hello again.")).toBe(1)
  })

  test("aggregates consecutive read calls into one preserved activity history", async () => {
    const harness = await createHarness("cli-chat-read-aggregation", createTurnProvider([
      async function* () {
        yield {
          type: "tool.call",
          callId: "call_read_one",
          name: "read",
          inputText: '{"path":"placeholder.txt"}',
        }
      },
      async function* () {
        yield {
          type: "tool.call",
          callId: "call_read_two",
          name: "read",
          inputText: '{"path":"second.txt"}',
        }
      },
      async function* () {
        yield { type: "text.delta", text: "Done reading." }
      },
    ]))
    await Bun.write(join(harness.workspaceRoot, "second.txt"), "second file")
    const output: string[] = []

    await runCli({
      argv: ["chat"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, ["Summarize the files", "/exit"]),
    })

    expect(output.join("")).toContain("| reading 1 file: placeholder.txt")
    expect(output.join("")).toContain("| reading 2 files: placeholder.txt | second.txt")
    expect(output.join("")).toContain("✓ read 2 files: placeholder.txt | second.txt")
    expect(output.join("")).toContain("assistant> Done reading.")
  })

  test("flushes a read activity group after inactivity before assistant text resumes", async () => {
    const harness = await createHarness("cli-chat-read-timeout", createTurnProvider([
      async function* () {
        yield {
          type: "tool.call",
          callId: "call_read_timeout",
          name: "read",
          inputText: '{"path":"placeholder.txt"}',
        }
        await Bun.sleep(220)
        yield { type: "text.delta", text: "Timeout flushed." }
      },
    ]))
    const output: string[] = []

    await runCli({
      argv: ["chat"],
      cwd: harness.workspaceRoot,
      workspaceRoot: harness.workspaceRoot,
      client: harness.client,
      io: createIo(output, ["Summarize the file", "/exit"]),
    })

    const rendered = output.join("")

    expect(rendered).toContain("| reading 1 file: placeholder.txt")
    expect(rendered).toContain("✓ read 1 file: placeholder.txt")
    expect(rendered).toContain("assistant> Timeout flushed.")
    expect(rendered.indexOf("✓ read 1 file: placeholder.txt")).toBeLessThan(
      rendered.indexOf("assistant> Timeout flushed."),
    )
  })

  test("recovers a permission-blocked local chat session across a fresh entrypoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-chat-local-permission-"))
    tempDirectories.push(directory)

    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

    const firstOutput: string[] = []
    let sigintHandler: (() => void) | undefined
    let releasePermissionPrompt!: () => void
    const permissionPromptVisible = new Promise<void>((resolve) => {
      releasePermissionPrompt = resolve
    })

    const firstChat = runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_local",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello from local chat"}',
          }
        },
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(firstOutput, ["Write notes.txt"], {
        onSigint(listener) {
          sigintHandler = listener
        },
        async prompt(message, options) {
          if (message.startsWith("permission>")) {
            releasePermissionPrompt()
            return new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" })),
                { once: true },
              )
            })
          }

          return "Write notes.txt"
        },
      }),
    })

    await permissionPromptVisible
    sigintHandler?.()
    await firstChat

    const firstStorage = createCliStorageComposition({
      workspaceRoot,
    })
    const sessionId = firstStorage.repository.sessions.list()[0]!.id
    const firstRun = firstStorage.repository.runs.listBySession(sessionId)[0]!

    expect(firstRun.status).toBe("waiting_permission")
    expect(firstStorage.permissionRepository.requests.listByRun(firstRun.id)).toMatchObject([
      {
        status: "pending",
        toolName: "write",
      },
    ])
    expect(firstOutput.join("")).not.toContain("status> cancelled")
    firstStorage.close()

    const secondOutput: string[] = []
    const secondAnswers = ["/resume", "/exit"]

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "Write finished." }
        },
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(secondOutput, [], {
        async prompt(message) {
          if (message.startsWith("permission>")) {
            secondOutput.push(`${message}y\n`)
            return "y"
          }

          const answer = secondAnswers.shift() ?? "/exit"
          secondOutput.push(`${message}${answer}\n`)
          return answer
        },
        async select() {
          return 0
        },
      }),
    })

    const secondStorage = createCliStorageComposition({
      workspaceRoot,
    })

    try {
      expect(secondStorage.repository.runs.get(firstRun.id).status).toBe("completed")
      expect(secondStorage.permissionRepository.requests.listByRun(firstRun.id)).toMatchObject([
        {
          status: "approved",
        },
      ])
    } finally {
      secondStorage.close()
    }

    expect(await readFile(join(workspaceRoot, "notes.txt"), "utf8")).toBe("hello from local chat")
    expect(secondOutput.join("")).toContain("assistant> Write finished.")
  })

  test("replays assistant output produced after detached permission recovery on a later resume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-chat-local-permission-replay-"))
    tempDirectories.push(directory)

    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

    let sigintHandler: (() => void) | undefined
    let releasePermissionPrompt!: () => void
    const permissionPromptVisible = new Promise<void>((resolve) => {
      releasePermissionPrompt = resolve
    })

    const firstChat = runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "让我先写入这个文件。" }
          yield {
            type: "tool.call",
            callId: "call_write_local_replay",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello from replay test"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "已经写好了。" }
        },
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo([], ["写入 notes.txt"], {
        onSigint(listener) {
          sigintHandler = listener
        },
        async prompt(message, options) {
          if (message.startsWith("permission>")) {
            releasePermissionPrompt()
            return new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" })),
                { once: true },
              )
            })
          }

          return "写入 notes.txt"
        },
      }),
    })

    await permissionPromptVisible
    sigintHandler?.()
    await firstChat

    const secondOutput: string[] = []
    const secondAnswers = ["/resume", "/exit"]

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "已经写好了。" }
        },
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(secondOutput, [], {
        async prompt(message) {
          if (message.startsWith("permission>")) {
            secondOutput.push(`${message}y\n`)
            return "y"
          }

          const answer = secondAnswers.shift() ?? "/exit"
          secondOutput.push(`${message}${answer}\n`)
          return answer
        },
        async select() {
          return 0
        },
      }),
    })

    const transcriptStorage = createCliStorageComposition({
      workspaceRoot,
    })
    const sessionId = transcriptStorage.repository.sessions.list()[0]!.id
    const transcript = transcriptStorage.repository.messages.listSessionTranscript(sessionId)
    transcriptStorage.close()

    expect(transcript.some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some((part) => part.kind === "text" && part.text?.includes("已经写好了。")),
    )).toBe(true)
    expect(secondOutput.join("")).toContain("assistant> 已经写好了。")

    const thirdOutput: string[] = []
    const thirdAnswers = ["/resume", "/exit"]

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(thirdOutput, [], {
        async prompt(message) {
          const answer = thirdAnswers.shift() ?? "/exit"
          thirdOutput.push(`${message}${answer}\n`)
          return answer
        },
        async select() {
          return 0
        },
      }),
    })

    const rendered = thirdOutput.join("")
    expect(rendered).toContain("you> 写入 notes.txt")
    expect(rendered).toContain("assistant> 让我先写入这个文件。")
    expect(rendered).toContain("assistant> 已经写好了。")
  })

  test("replays completed tool activity from a detached permission recovery on a later resume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-chat-local-permission-tool-history-"))
    tempDirectories.push(directory)

    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

    let sigintHandler: (() => void) | undefined
    let releasePermissionPrompt!: () => void
    const permissionPromptVisible = new Promise<void>((resolve) => {
      releasePermissionPrompt = resolve
    })

    const firstChat = runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "我来写入这个文件。" }
          yield {
            type: "tool.call",
            callId: "call_write_local_tool_history",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello from tool history"}',
          }
        },
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo([], ["写入 notes.txt"], {
        onSigint(listener) {
          sigintHandler = listener
        },
        async prompt(message, options) {
          if (message.startsWith("permission>")) {
            releasePermissionPrompt()
            return new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" })),
                { once: true },
              )
            })
          }

          return "写入 notes.txt"
        },
      }),
    })

    await permissionPromptVisible
    sigintHandler?.()
    await firstChat

    const secondOutput: string[] = []
    const secondAnswers = ["/resume", "/exit"]

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {},
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(secondOutput, [], {
        async prompt(message) {
          if (message.startsWith("permission>")) {
            secondOutput.push(`${message}y\n`)
            return "y"
          }

          const answer = secondAnswers.shift() ?? "/exit"
          secondOutput.push(`${message}${answer}\n`)
          return answer
        },
        async select() {
          return 0
        },
      }),
    })

    expect(secondOutput.join("")).toContain("✓ write: Wrote notes.txt")

    const thirdOutput: string[] = []
    const thirdAnswers = ["/resume", "/exit"]

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(thirdOutput, [], {
        async prompt(message) {
          const answer = thirdAnswers.shift() ?? "/exit"
          thirdOutput.push(`${message}${answer}\n`)
          return answer
        },
        async select() {
          return 0
        },
      }),
    })

    const rendered = thirdOutput.join("")
    expect(rendered).toContain("you> 写入 notes.txt")
    expect(rendered).toContain("assistant> 我来写入这个文件。")
    expect(rendered).toContain("✓ write: Wrote notes.txt")
  })

  test("replays completed read history before a later recovered tool activity on resume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-chat-local-permission-read-history-"))
    tempDirectories.push(directory)

    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

    let sigintHandler: (() => void) | undefined
    let releasePermissionPrompt!: () => void
    const permissionPromptVisible = new Promise<void>((resolve) => {
      releasePermissionPrompt = resolve
    })

    const firstChat = runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_before_write",
            name: "read",
            inputText: '{"path":"placeholder.txt"}',
          }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_after_read",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello after read"}',
          }
        },
        async function* () {},
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo([], ["先读再写"], {
        onSigint(listener) {
          sigintHandler = listener
        },
        async prompt(message, options) {
          if (message.startsWith("permission>")) {
            releasePermissionPrompt()
            return new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" })),
                { once: true },
              )
            })
          }

          return "先读再写"
        },
      }),
    })

    await permissionPromptVisible
    sigintHandler?.()
    await firstChat

    const secondOutput: string[] = []
    const secondAnswers = ["/resume", "/exit"]

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {},
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(secondOutput, [], {
        async prompt(message) {
          if (message.startsWith("permission>")) {
            secondOutput.push(`${message}y\n`)
            return "y"
          }

          const answer = secondAnswers.shift() ?? "/exit"
          secondOutput.push(`${message}${answer}\n`)
          return answer
        },
        async select() {
          return 0
        },
      }),
    })

    expect(secondOutput.join("")).toContain("✓ write: Wrote notes.txt")

    const thirdOutput: string[] = []
    const thirdAnswers = ["/resume", "/exit"]

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(thirdOutput, [], {
        async prompt(message) {
          const answer = thirdAnswers.shift() ?? "/exit"
          thirdOutput.push(`${message}${answer}\n`)
          return answer
        },
        async select() {
          return 0
        },
      }),
    })

    const rendered = thirdOutput.join("")
    expect(rendered).toContain("you> 先读再写")
    expect(rendered).toContain("✓ read 1 file: placeholder.txt")
    expect(rendered).toContain("✓ write: Wrote notes.txt")
    expect(rendered.indexOf("✓ read 1 file: placeholder.txt")).toBeLessThan(
      rendered.indexOf("✓ write: Wrote notes.txt"),
    )
  })

  test("cancels a permission-blocked local chat session on deny after a fresh entrypoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-chat-local-permission-deny-"))
    tempDirectories.push(directory)

    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

    let sigintHandler: (() => void) | undefined
    let releasePermissionPrompt!: () => void
    const permissionPromptVisible = new Promise<void>((resolve) => {
      releasePermissionPrompt = resolve
    })

    const firstChat = runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_local_deny",
            name: "write",
            inputText: '{"path":"notes.txt","content":"should not be written"}',
          }
        },
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo([], ["Write notes.txt"], {
        onSigint(listener) {
          sigintHandler = listener
        },
        async prompt(message, options) {
          if (message.startsWith("permission>")) {
            releasePermissionPrompt()
            return new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" })),
                { once: true },
              )
            })
          }

          return "Write notes.txt"
        },
      }),
    })

    await permissionPromptVisible
    sigintHandler?.()
    await firstChat

    const initialStorage = createCliStorageComposition({
      workspaceRoot,
    })
    const sessionId = initialStorage.repository.sessions.list()[0]!.id
    const blockedRun = initialStorage.repository.runs.listBySession(sessionId)[0]!
    expect(blockedRun.status).toBe("waiting_permission")
    initialStorage.close()

    const secondOutput: string[] = []
    const secondAnswers = ["/resume", "/exit"]

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          permissionPolicy: {
            write: "ask",
          },
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(secondOutput, [], {
        async prompt(message) {
          if (message.startsWith("permission>")) {
            secondOutput.push(`${message}n\n`)
            return "n"
          }

          const answer = secondAnswers.shift() ?? "/exit"
          secondOutput.push(`${message}${answer}\n`)
          return answer
        },
        async select() {
          return 0
        },
      }),
    })

    const finalStorage = createCliStorageComposition({
      workspaceRoot,
    })

    try {
      expect(finalStorage.repository.runs.get(blockedRun.id).status).toBe("cancelled")
      expect(finalStorage.permissionRepository.requests.listByRun(blockedRun.id)).toMatchObject([
        {
          status: "denied",
        },
      ])
    } finally {
      finalStorage.close()
    }

    await expect(readFile(join(workspaceRoot, "notes.txt"), "utf8")).rejects.toThrow()
    expect(secondOutput.join("")).toContain("error> Tool write failed: Permission denied")
    expect(secondOutput.join("")).toContain("status> cancelled")
  })

  test("supports chat through the local runtime composition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-chat-local-"))
    tempDirectories.push(directory)

    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

    const database = openStorageDatabase(join(directory, "agent.sqlite"))
    openDatabases.push(database)

    const repository = createStorageRepository({
      database,
    })
    const permissionRepository = createPermissionRepository({
      database,
    })
    const output: string[] = []

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "Local hello." }
        },
      ]),
      createLocalRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider: runtimeInput.provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          now: runtimeInput.now,
        })
      },
      createLocalStorageImpl() {
        return {
          repository,
          permissionRepository,
          closeImpl() {},
        }
      },
      io: createIo(output, ["Hello local", "/exit"]),
    })

    const sessions = repository.sessions.list()
    const runs = repository.runs.listBySession(sessions[0]!.id)

    expect(sessions).toHaveLength(1)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: "completed",
      trigger: "cli",
    })
    expect(output.join("")).toContain("you> Hello local")
    expect(output.join("")).toContain("assistant> Local hello.")
  })
})

async function createHarness(
  prefix: string,
  provider: OrchestrationModelPort,
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
  const permissionRepository = createPermissionRepository({
    database,
  })
  const server = createAgentServer({
    createRuntimeImpl(runtimeInput) {
      return createRuntime({
        provider,
        repository: runtimeInput.repository,
        permissionRepository: runtimeInput.permissionRepository,
        permissionPolicy: options.permissionPolicy,
        now: runtimeInput.now,
      })
    },
    repository,
    permissionRepository,
    heartbeatIntervalMs: 15,
  })
  activeServers.push(server)

  return {
    workspaceRoot,
    repository,
    permissionRepository,
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
    select?(
      message: string,
      items: Array<{ label: string; description?: string }>,
    ): Promise<number | null> | number | null
    prompt?(message: string, options?: { signal?: AbortSignal }): Promise<string>
    startStatus?(text: string): void
    updateStatus?(text: string): void
    finishStatus?(text: string): void
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

      const answer = promptAnswers.shift() ?? "y"
      output.push(`${message}${answer}\n`)
      return answer
    },
    async select(message: string, items: Array<{ label: string; description?: string }>) {
      if (hooks.select) {
        return hooks.select(message, items)
      }

      output.push(`${message}\n`)
      return items.length > 0 ? 0 : null
    },
    startStatus(text: string) {
      if (hooks.startStatus) {
        hooks.startStatus(text)
        return
      }

      output.push(`| ${text}\n`)
    },
    updateStatus(text: string) {
      if (hooks.updateStatus) {
        hooks.updateStatus(text)
        return
      }

      output.push(`| ${text}\n`)
    },
    finishStatus(text: string) {
      if (hooks.finishStatus) {
        hooks.finishStatus(text)
        return
      }

      output.push(`✓ ${text}\n`)
    },
    onSigint(listener: () => void) {
      hooks.onSigint?.(listener)
    },
  }
}

function createLocalCliStorage(workspaceRoot: string) {
  const storage = createCliStorageComposition({
    workspaceRoot,
  })

  return {
    repository: storage.repository,
    permissionRepository: storage.permissionRepository,
    closeImpl() {
      storage.close()
    },
  }
}

function createTurnProvider(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
){
  let index = 0

  return createModelProvider({
    runtime: createModelRuntimeApi({
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
    }),
  })
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
