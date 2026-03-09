import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "../../src/cli/run-command"
import { getDefaultCliStoragePath } from "../../src/runtime/runtime"
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
  test("completes a read-only request through the default provider CLI path", async () => {
    const output: string[] = []
    const directory = await mkdtemp(join(tmpdir(), "agent-run-e2e-"))
    tempDirectories.push(directory)
    const workspaceRoot = join(directory, "workspace")
    await cp("test/fixtures/workspaces/e2e", workspaceRoot, { recursive: true })

    let turn = 0

    await runCli({
      argv: ["run", "Read README.md and summarize it"],
      cwd: workspaceRoot,
      workspaceRoot,
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
})

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}
