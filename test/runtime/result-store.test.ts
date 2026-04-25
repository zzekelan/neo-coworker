import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { createResultStore } from "../../src/tool"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("runtime result store", () => {
  test("saves and loads content under a session-scoped tool result path", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const store = createResultStore({ workspaceRoot, sessionId: "ses_abc" })

    const saved = store.save("hello", "agent")

    expect(saved).toBeDefined()
    expect(saved?.path).toMatch(/^\.ncoworker\/tool-results\/ses_abc\/agent\/[a-f0-9]{64}\.txt$/)
    expect(saved?.deduplicated).toBe(false)
    expect(store.load(saved?.path ?? "")).toBe("hello")
  })

  test("does not persist or create the old tool-scoped layout without a session", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const store = createResultStore({ workspaceRoot })

    const saved = store.save("hello", "agent")

    expect(saved).toBeUndefined()
    await expect(readdir(join(workspaceRoot, ".ncoworker/tool-results/agent"))).rejects.toThrow()
  })

  test("deduplicates repeated content within the same session and preserves content", async () => {
    const workspaceRoot = await createWorkspaceRoot()
    const store = createResultStore({ workspaceRoot, sessionId: "ses_abc" })

    const first = store.save("same content", "agent")
    const second = store.save("same content", "agent")

    expect(first).toBeDefined()
    expect(second).toEqual({
      path: first?.path,
      deduplicated: true,
    })
    expect(await readdir(join(workspaceRoot, ".ncoworker/tool-results/ses_abc/agent"))).toHaveLength(1)
    expect(await readFile(join(workspaceRoot, first?.path ?? ""), "utf8")).toBe("same content")
  })
})

async function createWorkspaceRoot() {
  const directory = await mkdtemp(join(tmpdir(), "neo-coworker-runtime-result-store-"))
  tempDirectories.push(directory)
  return directory
}
