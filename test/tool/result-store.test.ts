import { mkdtemp, readdir, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  createResultStore,
  type ToolObserverEvent,
} from "../../src/tool"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("result store", () => {
  test("saves and loads content with a tool-scoped content-addressed path", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const store = createResultStore({ workspaceRoot })

    const saved = store.save("hello world", "read")

    expect(saved).toBeDefined()
    expect(saved?.path).toMatch(/^\.ncoworker\/tool-results\/read\/[a-f0-9]{64}\.txt$/)
    expect(saved?.deduplicated).toBe(false)
    expect(store.load(saved?.path ?? "")).toBe("hello world")
  })

  test("deduplicates repeated content for the same tool", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const store = createResultStore({ workspaceRoot })

    const first = store.save("same content", "read")
    const second = store.save("same content", "read")

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(second).toEqual({
      path: first?.path,
      deduplicated: true,
    })

    const savedFiles = await readdir(join(workspaceRoot, ".ncoworker/tool-results/read"))
    expect(savedFiles).toHaveLength(1)
  })

  test("cleanup removes stale files older than the cutoff", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const store = createResultStore({ workspaceRoot })
    const oldEntry = store.save("old content", "read")
    const freshEntry = store.save("fresh content", "read")

    expect(oldEntry).toBeDefined()
    expect(freshEntry).toBeDefined()

    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1_000)
    await utimes(join(workspaceRoot, oldEntry?.path ?? ""), oldDate, oldDate)

    const removed = store.cleanup(new Date(Date.now() - 24 * 60 * 60 * 1_000))

    expect(removed).toBe(1)
    expect(store.load(oldEntry?.path ?? "")).toBeNull()
    expect(store.load(freshEntry?.path ?? "")).toBe("fresh content")
  })

  test("returns null when loading a missing file", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const store = createResultStore({ workspaceRoot })

    expect(store.load(".ncoworker/tool-results/read/missing.txt")).toBeNull()
  })

  test("emits budget.persisted_to_disk telemetry for saves and deduplicated re-saves", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const events: ToolObserverEvent[] = []
    const store = createResultStore({
      workspaceRoot,
      observer: {
        recordToolEvent(event: ToolObserverEvent) {
          events.push(event)
        },
      },
      sessionId: "session-1",
      runId: "run-1",
    })

    const first = store.save("persist me", "read")
    const second = store.save("persist me", "read")

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(events).toHaveLength(2)

    const [firstEvent, secondEvent] = events

    expect(firstEvent?.type).toBe("budget.persisted_to_disk")
    if (firstEvent?.type !== "budget.persisted_to_disk") {
      throw new Error("Expected budget.persisted_to_disk event")
    }
    expect(firstEvent.sessionId).toBe("session-1")
    expect(firstEvent.runId).toBe("run-1")
    expect(firstEvent.toolName).toBe("read")
    expect(firstEvent.contentSize).toBe(10)
    expect(firstEvent.path).toBe(first?.path)
    expect(firstEvent.deduplicated).toBe(false)

    expect(secondEvent?.type).toBe("budget.persisted_to_disk")
    if (secondEvent?.type !== "budget.persisted_to_disk") {
      throw new Error("Expected budget.persisted_to_disk event")
    }
    expect(secondEvent.path).toBe(first?.path)
    expect(secondEvent.deduplicated).toBe(true)
  })
})

async function createWorkspaceRoot() {
  const directory = await mkdtemp(join(tmpdir(), "neo-coworker-result-store-"))
  tempDirectories.push(directory)
  return directory
}
