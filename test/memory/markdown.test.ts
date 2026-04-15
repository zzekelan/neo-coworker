import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { createMarkdownMemoryRepository, getMemoryFilePath } from "../../src/memory"

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("markdown memory repository", () => {
  test("returns empty entries when files do not exist", async () => {
    const basePath = await createTempDirectory("memory-markdown-empty-")
    const repository = createMarkdownMemoryRepository(basePath)

    expect(await repository.load("agent")).toEqual([])
    expect(await repository.load("user")).toEqual([])
  })

  test("persists agent and user entries to their dedicated markdown files", async () => {
    const basePath = await createTempDirectory("memory-markdown-targets-")
    const repository = createMarkdownMemoryRepository(basePath)

    const agentEntries = [
      {
        target: "agent" as const,
        content: "Project uses Bun.",
        metadata: { source: "workspace" },
      },
    ]
    const userEntries = [
      {
        target: "user" as const,
        content: "Prefers concise answers.",
      },
    ]

    await repository.save("agent", agentEntries)
    await repository.save("user", userEntries)

    expect(await repository.load("agent")).toEqual(agentEntries)
    expect(await repository.load("user")).toEqual(userEntries)

    expect(await readFile(getMemoryFilePath(basePath, "agent"), "utf8")).toContain(
      'source: "workspace"',
    )
    expect(await readFile(getMemoryFilePath(basePath, "user"), "utf8")).toContain(
      "Prefers concise answers.",
    )
  })

  test("round-trips multiline content and metadata frontmatter", async () => {
    const basePath = await createTempDirectory("memory-markdown-roundtrip-")
    const repository = createMarkdownMemoryRepository(basePath)
    const entries = [
      {
        target: "agent" as const,
        content: "Line one\nLine two",
        metadata: {
          topic: "workflow",
          note: "keep",
        },
      },
      {
        target: "agent" as const,
        content: "Second entry",
      },
    ]

    await repository.save("agent", entries)

    expect(await repository.load("agent")).toEqual(entries)
  })

  test("writes atomically without leaving temporary files behind", async () => {
    const basePath = await createTempDirectory("memory-markdown-atomic-")
    const repository = createMarkdownMemoryRepository(basePath)

    await repository.save("agent", [
      {
        target: "agent",
        content: "First entry",
      },
    ])
    await repository.save("agent", [
      {
        target: "agent",
        content: "Second entry",
      },
    ])

    const directoryEntries = await readdir(basePath)
    const fileName = basename(getMemoryFilePath(basePath, "agent"))

    expect(directoryEntries).not.toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^\\.${fileName}\\..+\\.tmp$`))]),
    )
    expect(await readFile(getMemoryFilePath(basePath, "agent"), "utf8")).toContain("Second entry")
  })
})

async function createTempDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}
