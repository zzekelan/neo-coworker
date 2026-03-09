import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "../../src/cli/run-command"
import { createRuntime } from "../../src/runtime/runtime"
import { createSessionRunService } from "../../src/session"
import { createStorageRepository, openStorageDatabase } from "../../src/storage"
import type { ProviderTurnRequest } from "../../src/providers/types"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("agent run e2e", () => {
  test("completes a read-only request against a fixture workspace", async () => {
    const output: string[] = []
    const directory = await mkdtemp(join(tmpdir(), "agent-run-e2e-"))
    tempDirectories.push(directory)

    const database = trackDatabase(openStorageDatabase(join(directory, "agent.sqlite")))
    const repository = createStorageRepository({ database })
    const service = createSessionRunService({ repository })
    let turn = 0
    const runtime = createRuntime({
      provider: {
        async *streamTurn(_request: ProviderTurnRequest) {
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
      },
      repository,
    })
    const session = repository.sessions.create({
      id: "session_e2e",
      directory: "test/fixtures/workspaces/e2e",
      workspaceRoot: "test/fixtures/workspaces/e2e",
      createdAt: 1,
    })

    await runCli({
      argv: ["run", "Read README.md and summarize it"],
      cwd: session.directory,
      workspaceRoot: session.workspaceRoot,
      runtime: {
        async run(input) {
          const started = service.startRun({
            sessionId: session.id,
            runId: "run_e2e",
            messageId: "message_e2e_user",
            createdAt: 2,
            messageCreatedAt: 3,
          })
          repository.parts.create({
            id: "part_e2e_user",
            sessionId: session.id,
            runId: started.run.id,
            messageId: started.message.id,
            kind: "text",
            sequence: 0,
            text: input.prompt,
            createdAt: 4,
          })

          return runtime.run({
            sessionId: session.id,
            runId: started.run.id,
          })
        },
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
  })
})

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}
