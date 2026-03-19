import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModelRuntimeApi } from "../../src/model/runtime/api"
import { createModelProvider } from "../../src/model"
import {
  runCli,
} from "../../src/orchestration/wiring/cli"
import { createAgentServer } from "../../src/orchestration/wiring/server"
import {
  createCliStorageComposition,
  createRuntime,
  getDefaultCliStoragePath,
} from "../../src/bootstrap/runtime"
import { createPermissionRepository } from "../../src/permission/repo"
import {
  createSessionRepository as createStorageRepository,
  openSessionDatabase as openStorageDatabase,
} from "../../src/session/repo"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []
const activeServers: Array<{ stop(): Promise<void> | void }> = []
const activeProcesses: Bun.Subprocess[] = []

afterEach(async () => {
  while (activeProcesses.length > 0) {
    const process = activeProcesses.pop()!
    if (process.exitCode == null) {
      process.kill("SIGKILL")
    }
    await process.exited
  }

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

describe("agent run e2e", () => {
  test("completes a read-only request through the default provider CLI path", async () => {
    const output: string[] = []
    const directory = await mkdtemp(join(tmpdir(), "agent-run-e2e-"))
    tempDirectories.push(directory)
    const workspaceRoot = join(directory, "workspace")
    await cp("test/fixtures/workspaces/e2e", workspaceRoot, { recursive: true })

    let turn = 0

    const provider = createModelProvider({
      runtime: createModelRuntimeApi({
        async *streamTurn() {
          turn += 1

          if (turn === 1) {
            yield { type: "text.delta", text: "Opening README.md\n" }
            yield {
              type: "tool.call",
              callId: "call_1",
              name: "read",
              inputText: '{"path":"README.md"}',
            }
            return
          }

          if (turn === 2) {
            yield { type: "text.delta", text: "Summary: concise fixture summary.\n" }
            return
          }

          throw new Error(`Unexpected provider turn ${turn}`)
        },
      }),
    })

    await runCli({
      argv: ["run", "Read README.md and summarize it"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider,
      createLocalRuntimeImpl(input) {
        return createRuntime(input)
      },
      createLocalStorageImpl(workspaceRoot) {
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
      },
      io: {
        write(text: string) {
          output.push(text)
        },
        async prompt() {
          throw new Error("read-only e2e should not request permission")
        },
        onSigint() {},
      },
    })

    const rendered = output.join("")

    expect(rendered).toContain("run.started")
    expect(rendered).toContain("tool.call.completed read:")
    expect(rendered).toContain("# e2e fixture")
    expect(rendered).toContain("Summary: concise fixture summary.")
    expect(rendered).toContain("run.completed")

    const database = trackDatabase(openStorageDatabase(getDefaultCliStoragePath(workspaceRoot)))
    const repository = createStorageRepository({ database })
    const sessionRow = database.query("SELECT id FROM session LIMIT 1").get() as { id: string } | null
    const runRow = database.query("SELECT id FROM run LIMIT 1").get() as { id: string } | null
    const transcript = repository.messages.listSessionTranscript(sessionRow!.id)

    expect(runRow).not.toBeNull()
    expect(repository.runs.get(runRow!.id).status).toBe("completed")
    expect(transcript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(transcript[1]?.parts.map((part) => part.kind)).toEqual(["text", "tool_call", "tool_result"])
    expect(transcript[2]?.parts).toMatchObject([
      { kind: "text", text: "Summary: concise fixture summary.\n" },
    ])
  })

  test("completes through the remote-client CLI path over real HTTP and SSE", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-run-remote-e2e-"))
    tempDirectories.push(directory)
    const workspaceRoot = join(directory, "workspace")
    await cp("test/fixtures/workspaces/e2e", workspaceRoot, { recursive: true })

    const database = trackDatabase(openStorageDatabase(join(directory, "server.sqlite")))
    const repository = createStorageRepository({ database })
    const permissionRepository = createPermissionRepository({ database })
    const serverState: { turn?: number } = {}
    const provider = createModelProvider({
      runtime: createModelRuntimeApi({
        async *streamTurn() {
          if (!("turn" in serverState)) {
            serverState.turn = 0
          }
          serverState.turn += 1

          if (serverState.turn === 1) {
            yield { type: "text.delta", text: "Opening README.md\n" }
            yield {
              type: "tool.call",
              callId: "call_1",
              name: "read",
              inputText: '{"path":"README.md"}',
            }
            return
          }

          if (serverState.turn === 2) {
            yield { type: "text.delta", text: "Summary: concise fixture summary.\n" }
            return
          }

          throw new Error(`Unexpected provider turn ${serverState.turn}`)
        },
      }),
    })
    const server = createAgentServer({
      createRuntimeImpl(runtimeInput) {
        return createRuntime({
          provider,
          repository: runtimeInput.repository,
          permissionRepository: runtimeInput.permissionRepository,
          now: runtimeInput.now,
        })
      },
      repository,
      permissionRepository,
    })
    activeServers.push(server)
    await server.start({
      hostname: "127.0.0.1",
    })

    const cli = Bun.spawn({
      cmd: [
        "bun",
        "run",
        join(globalThis.process.cwd(), "src/wiring/main.ts"),
        "run",
        "Read README.md and summarize it",
      ],
      cwd: workspaceRoot,
      env: buildLoopbackEnv({
        AGENT_SERVER_URL: server.baseUrl,
      }),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    activeProcesses.push(cli)

    const exitCode = await Promise.race([
      cli.exited,
      Bun.sleep(10_000).then(() => {
        cli.kill("SIGKILL")
        throw new Error("Timed out waiting for remote CLI process to exit")
      }),
    ])
    const stderr = await readProcessStream(cli.stderr)
    const stdout = await readProcessStream(cli.stdout)

    expect(exitCode).toBe(0)
    expect(stderr.trim()).toBe("")

    const rendered = stdout
    expect(rendered).toContain("session.created")
    expect(rendered).toContain("run.started")
    expect(rendered).toContain("tool.call.completed read:")
    expect(rendered).toContain("# e2e fixture")
    expect(rendered).toContain("Summary: concise fixture summary.")
    expect(rendered).toContain("run.completed")

    const sessionRow = database.query("SELECT id FROM session LIMIT 1").get() as { id: string } | null
    const runRow = database.query("SELECT id FROM run LIMIT 1").get() as { id: string } | null
    const transcript = repository.messages.listSessionTranscript(sessionRow!.id)

    expect(runRow).not.toBeNull()
    expect(repository.runs.get(runRow!.id).status).toBe("completed")
    expect(transcript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
  })
})

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}

function buildLoopbackEnv(overrides: Record<string, string>) {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) {
      env[key] = value
    }
  }

  delete env.HTTP_PROXY
  delete env.HTTPS_PROXY
  delete env.ALL_PROXY
  delete env.http_proxy
  delete env.https_proxy
  delete env.all_proxy
  env.NO_PROXY = "127.0.0.1,localhost"
  env.no_proxy = "127.0.0.1,localhost"

  return {
    ...env,
    ...overrides,
  }
}

async function readProcessStream(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) {
    return ""
  }

  return await new Response(stream).text()
}
