import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

declare const Bun: {
  write(path: string, data: string): Promise<number>
}

import { createCliStorageComposition, createRuntime } from "../../src/bootstrap"
import { createAgentServerClient, runCli } from "../../src/cli"
import {
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
  createModelProvider,
} from "../../src/model"

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("CLI --agent flag", () => {
  test("includes agent in remote startRun requests when provided", async () => {
    const requests: Request[] = []
    const client = createAgentServerClient({
      origin: "http://server.test",
      async send(request) {
        requests.push(request)

        return new Response(JSON.stringify({
          data: {
            run: { id: "run_123" },
            message: { id: "message_123" },
          },
        }), {
          status: 201,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    })

    await client.startRun({
      sessionId: "session_123",
      prompt: "hello",
      trigger: "cli",
      agent: "plan",
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toBe("http://server.test/sessions/session_123/runs")
    expect(await requests[0]!.clone().json()).toEqual({
      prompt: "hello",
      trigger: "cli",
      agent: "plan",
    })
  })

  test("omits agent in remote startRun requests when absent", async () => {
    const requests: Request[] = []
    const client = createAgentServerClient({
      origin: "http://server.test",
      async send(request) {
        requests.push(request)

        return new Response(JSON.stringify({
          data: {
            run: { id: "run_123" },
            message: { id: "message_123" },
          },
        }), {
          status: 201,
          headers: {
            "content-type": "application/json",
          },
        })
      },
    })

    await client.startRun({
      sessionId: "session_123",
      prompt: "hello",
      trigger: "cli",
    })

    expect(await requests[0]!.clone().json()).toEqual({
      prompt: "hello",
      trigger: "cli",
    })
  })

  test("passes --agent through the local run command path", async () => {
    const workspaceRoot = await createWorkspace("cli-agent-local-run")

    await runCli({
      argv: ["run", "--agent", "plan", "Use plan mode"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "Planned." }
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
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(),
    })

    const storage = createCliStorageComposition({
      workspaceRoot,
    })

    try {
      const sessionId = storage.repository.sessions.list()[0]!.id
      expect(storage.repository.sessions.getCurrentAgent(sessionId)).toBe("plan")
      expect(storage.repository.messages.listSessionTranscript(sessionId)[0]?.agent).toBe("plan")
    } finally {
      storage.close()
    }
  })

  test("omitting --agent preserves default behavior through the local chat path", async () => {
    const workspaceRoot = await createWorkspace("cli-agent-local-chat")

    await runCli({
      argv: ["chat"],
      cwd: workspaceRoot,
      workspaceRoot,
      provider: createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "Default reply." }
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
      createLocalStorageImpl(root) {
        return createLocalCliStorage(root)
      },
      io: createIo(["Hello there", "/exit"]),
    })

    const storage = createCliStorageComposition({
      workspaceRoot,
    })

    try {
      const sessionId = storage.repository.sessions.list()[0]!.id
      expect(storage.repository.sessions.getCurrentAgent(sessionId)).toBe("default")
      expect(storage.repository.messages.listSessionTranscript(sessionId)[0]?.agent).toBe("default")
    } finally {
      storage.close()
    }
  })
})

async function createWorkspace(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  await mkdir(workspaceRoot, { recursive: true })
  await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")
  return workspaceRoot
}

function createLocalCliStorage(workspaceRoot: string) {
  const storage = createCliStorageComposition({
    workspaceRoot,
  })

  return {
    database: storage.database,
    repository: storage.repository,
    permissionRepository: storage.permissionRepository,
    closeImpl() {
      storage.close()
    },
  }
}

function createIo(promptAnswers: string[] = []) {
  return {
    write() {},
    async prompt() {
      return promptAnswers.shift() ?? "/exit"
    },
  }
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
