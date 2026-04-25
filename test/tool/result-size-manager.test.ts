import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  createToolRuntimeApi,
  manageResultSize,
  type ToolObserverEvent,
} from "../../src/tool"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("manageResultSize", () => {
  test("passes through results under the default limit unchanged", () => {
    const output = "a".repeat(1_024)

    const managed = manageResultSize({ output })

    expect(managed.output).toBe(output)
    expect(managed.metadata?.truncated).toBeUndefined()
  })

  test("does not truncate error results", () => {
    const output = "e".repeat(100_000)

    const managed = manageResultSize({ output, isError: true })

    expect(managed.output).toBe(output)
    expect(managed.metadata?.truncated).toBeUndefined()
  })

  test("persists oversized results to disk and includes the saved path in the message", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const output = "x".repeat(75_000)

    const managed = manageResultSize(
      { output },
      {
        tool: { name: "read", resultSizeLimit: 50_000 },
        workspaceRoot,
        sessionId: "session-1",
      },
    )

    const savedPath = managed.metadata?.savedPath

    expect(typeof savedPath).toBe("string")
    expect(savedPath).toMatch(/^\.ncoworker\/tool-results\/session-1\/read\/[a-f0-9]{64}\.txt$/)
    expect(managed.output).toContain(`[Result truncated: 75000B → 50000B. Full result saved to ${savedPath}]`)
    expect(managed.metadata).toMatchObject({
      truncated: true,
      originalSize: 75_000,
      truncatedSize: 50_000,
      resultSizeLimit: 50_000,
      savedPath,
    })
    expect(await readFile(join(workspaceRoot, savedPath as string), "utf8")).toBe(output)
  })

  test("does not make a false persistence claim without workspace storage context", () => {
    const managed = manageResultSize(
      { output: "x".repeat(75_000) },
      { tool: { name: "read", resultSizeLimit: 50_000 } },
    )

    expect(managed.output).toContain(
      "[Result truncated: 75000B → 50000B. Full result was not persisted in this context.]",
    )
    expect(managed.output).not.toContain("Full result saved to")
    expect(managed.metadata?.savedPath).toBeUndefined()
  })

  test("uses resultSizeLimit from runtime-listed tool entries instead of the default limit", () => {
    const output = "x".repeat(80_000)
    const runtime = createToolRuntimeApi({
      tools: [
        {
          name: "demo",
          description: "demo",
          resultSizeLimit: 100_000,
          execute() {
            return { output: "ok" }
          },
        },
      ],
    })
    const tool = runtime.list()[0]

    const managed = manageResultSize(
      { output },
      { tool },
    )

    expect(managed.output).toBe(output)
    expect(managed.metadata?.truncated).toBeUndefined()
  })

  test("explicit limits override the tool resultSizeLimit", () => {
    const managed = manageResultSize(
      { output: "x".repeat(80_000) },
      {
        limit: 40_000,
        tool: { name: "read", resultSizeLimit: 100_000 },
      },
    )

    expect(managed.metadata).toMatchObject({
      truncated: true,
      originalSize: 80_000,
      truncatedSize: 40_000,
      resultSizeLimit: 40_000,
    })
  })

  test("emits budget.result_truncated with the saved path and sizes", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const events: ToolObserverEvent[] = []

    const managed = manageResultSize(
      { output: "x".repeat(75_000) },
      {
        tool: { name: "read", resultSizeLimit: 50_000 },
        workspaceRoot,
        observer: {
          recordToolEvent(event: ToolObserverEvent) {
            events.push(event)
          },
        },
        sessionId: "session-1",
        runId: "run-1",
      },
    )

    const persistedEvent = events.find((event) => event.type === "budget.persisted_to_disk")
    const event = events.find((entry) => entry.type === "budget.result_truncated")

    expect(events).toHaveLength(2)
    expect(persistedEvent).toBeDefined()
    expect(persistedEvent?.type).toBe("budget.persisted_to_disk")
    if (persistedEvent?.type !== "budget.persisted_to_disk") {
      throw new Error("Expected budget.persisted_to_disk event")
    }
    expect(persistedEvent.sessionId).toBe("session-1")
    expect(persistedEvent.runId).toBe("run-1")
    expect(persistedEvent.toolName).toBe("read")
    expect(persistedEvent.contentSize).toBe(75_000)
    expect(persistedEvent.path).toBe(managed.metadata?.savedPath)
    expect(persistedEvent.deduplicated).toBe(false)
    expect(event).toBeDefined()
    expect(event?.type).toBe("budget.result_truncated")
    if (event?.type !== "budget.result_truncated") {
      throw new Error("Expected budget.result_truncated event")
    }
    expect(event.sessionId).toBe("session-1")
    expect(event.runId).toBe("run-1")
    expect(event.toolName).toBe("read")
    expect(event.originalSize).toBe(75_000)
    expect(event.truncatedSize).toBe(50_000)
    expect(event.limit).toBe(50_000)
    expect(event.savedPath).toBe(managed.metadata?.savedPath)
  })
})

async function createWorkspaceRoot() {
  const directory = await mkdtemp(join(tmpdir(), "neo-coworker-result-size-"))
  tempDirectories.push(directory)
  return directory
}
