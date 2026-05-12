import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRuntime } from "../../src/bootstrap"
import { createPermissionRepository } from "../../src/permission"
import {
  createSessionRepository,
  createSessionRunService,
  openSessionDatabase,
} from "../../src/session"
import {
  createModelProvider,
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model"
import { createShadowGitCheckpointStore } from "../../src/tool"

declare const Bun: {
  spawn(
    command: string[],
    options: {
      cwd: string
      stdin: "ignore"
      stdout: "pipe"
      stderr: "pipe"
    },
  ): {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
    kill(signal?: string): void
  }
}

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("integration: shadow git wiring", () => {
  test("write tool triggers a transparent checkpoint before mutation", async () => {
    const harness = await createGitHarness("shadow-git-write")
    await writeFile(join(harness.workspaceRoot, "notes.txt"), "draft before checkpoint\n", "utf8")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_shadow_git_write",
      messageId: "message_shadow_git_write",
      prompt: "Write notes.txt",
    })

    const runtime = createRuntime({
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: JSON.stringify({
              path: join(harness.workspaceRoot, "notes.txt"),
              content: "updated\n",
            }),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Done." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      permissionPolicy: {
        write: "allow",
      },
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    await collectEvents(handle.events)

    const store = createShadowGitCheckpointStore()
    const checkpoints = await store.list(harness.workspaceRoot)

    expect(checkpoints.length).toBeGreaterThanOrEqual(1)
    expect(checkpoints[0]?.description).toBe(`before write ${join(harness.workspaceRoot, "notes.txt")}`)
    await expect(readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).resolves.toBe("updated\n")

    await store.restore(harness.workspaceRoot, checkpoints[0]!.id)
    await expect(readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).resolves.toBe("draft before checkpoint\n")
  })

  test("non-mutating read tool does not trigger checkpoints", async () => {
    const harness = await createGitHarness("shadow-git-read")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_shadow_git_read",
      messageId: "message_shadow_git_read",
      prompt: "Read notes.txt",
    })

    const runtime = createRuntime({
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read",
            name: "read",
            inputText: JSON.stringify({ path: "notes.txt" }),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Done." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    await collectEvents(handle.events)

    const store = createShadowGitCheckpointStore()
    await expect(store.list(harness.workspaceRoot)).resolves.toEqual([])
  })

  test("checkpointing stays invisible to the model-facing tool surface", async () => {
    const harness = await createGitHarness("shadow-git-invisible")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_shadow_git_invisible",
      messageId: "message_shadow_git_invisible",
      prompt: "Mutate notes.txt",
    })

    const listedToolNames: string[][] = []
    const runtime = createRuntime({
      provider: createTurnProvider([
        async function* (request) {
          listedToolNames.push(request.tools.map((tool) => tool.name))
          yield {
            type: "tool.call",
            callId: "call_write_invisible",
            name: "write",
            inputText: JSON.stringify({
              path: join(harness.workspaceRoot, "notes.txt"),
              content: "updated\n",
            }),
          }
        },
        async function* (request) {
          listedToolNames.push(request.tools.map((tool) => tool.name))
          yield { type: "text.delta", text: "Done." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      permissionPolicy: {
        write: "allow",
      },
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    await collectEvents(handle.events)

    for (const names of listedToolNames) {
      expect(names).not.toContain("checkpoint")
      expect(names).not.toContain("shadow_git")
    }

    const timeline = harness.repository.messages.listSessionTimeline(harness.session.id)
    const texts = timeline.flatMap((message) => message.parts.map((part) => part.text))
    expect(
      texts.some((text) => text === `Created checkpoint before write ${join(harness.workspaceRoot, "notes.txt")}.`),
    ).toBe(false)
  })
})

async function createGitHarness(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  const databasePath = join(directory, "agent.sqlite")
  await mkdir(workspaceRoot, { recursive: true })
  await initializeGitWorkspace(workspaceRoot)

  const now = createMonotonicClock()
  const database = openSessionDatabase(databasePath)
  openDatabases.push(database)
  const repository = createSessionRepository({ database, now })
  const permissionRepository = createPermissionRepository({ database, now })
  const service = createSessionRunService({ repository, now })
  const session = repository.sessions.create({
    id: `${prefix}_session`,
    directory: workspaceRoot,
    workspaceRoot,
    createdAt: now(),
  })

  return {
    workspaceRoot,
    repository,
    permissionRepository,
    service,
    session,
    now,
  }
}

async function initializeGitWorkspace(workspaceRoot: string) {
  await runGit(workspaceRoot, ["init"])
  await runGit(workspaceRoot, ["config", "user.email", "test@example.com"])
  await runGit(workspaceRoot, ["config", "user.name", "Test User"])
  await writeFile(join(workspaceRoot, "notes.txt"), "initial\n", "utf8")
  await runGit(workspaceRoot, ["add", "notes.txt"])
  await runGit(workspaceRoot, ["commit", "-m", "initial"])
}

function startPromptRun(input: {
  repository: ReturnType<typeof createSessionRepository>
  service: ReturnType<typeof createSessionRunService>
  sessionId: string
  runId: string
  messageId: string
  prompt: string
}) {
  const started = input.service.startRun({
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: input.messageId,
  })

  input.repository.parts.create({
    sessionId: input.sessionId,
    runId: started.run.id,
    messageId: started.message.id,
    kind: "text",
    sequence: 0,
    text: input.prompt,
  })

  return started
}

function createTurnProvider(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
) {
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

async function collectEvents(events: AsyncIterable<unknown>) {
  const collected: unknown[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

function createMonotonicClock() {
  let current = 100
  return () => {
    current += 1
    return current
  }
}

async function runGit(workspaceRoot: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], {
    cwd: workspaceRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`)
  }

  return stdout.trim()
}
