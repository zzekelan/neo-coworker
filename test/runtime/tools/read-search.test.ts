import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createReadTool } from "../../../src/runtime/tools/read"
import { createToolRegistry } from "../../../src/runtime/tools/registry"
import { createSearchTool } from "../../../src/runtime/tools/search"

function createRegistry() {
  return createToolRegistry([createReadTool(), createSearchTool()])
}

describe("read-only tools", () => {
  test("reads files relative to the workspace root", async () => {
    const registry = createRegistry()

    const result = await registry.execute({
      toolName: "read",
      args: { path: "README.md" },
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    expect(result.output).toContain("demo workspace")
  })

  test("search finds matching files and line snippets", async () => {
    const registry = createRegistry()

    const result = await registry.execute({
      toolName: "search",
      args: { query: "helloDemo" },
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    expect(result.output).toContain("src/demo.ts")
    expect(result.output).toContain("helloDemo")
  })

  test("read rejects symlinks that escape the workspace", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "read-search-workspace-"))
    const externalRoot = await mkdtemp(join(tmpdir(), "read-search-external-"))
    const externalFile = join(externalRoot, "secret.txt")
    const symlinkDir = join(workspaceRoot, "links")

    await writeFile(externalFile, "top secret\n")
    await mkdir(symlinkDir, { recursive: true })
    await symlink(externalFile, join(symlinkDir, "secret.txt"))

    await expect(
      registry.execute({
        toolName: "read",
        args: { path: "links/secret.txt" },
        workspaceRoot,
      }),
    ).rejects.toThrow("Path must stay inside workspace")
  })

  test("search rejects empty or whitespace-only queries", async () => {
    const registry = createRegistry()

    await expect(
      registry.execute({
        toolName: "search",
        args: { query: "   " },
        workspaceRoot: "test/fixtures/workspaces/read-search",
      }),
    ).rejects.toThrow("Query must not be empty")
  })

  test("search skips heavy directories", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "read-search-workspace-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await mkdir(join(workspaceRoot, "node_modules"), { recursive: true })
    await mkdir(join(workspaceRoot, ".git"), { recursive: true })
    await mkdir(join(workspaceRoot, ".worktrees"), { recursive: true })

    await writeFile(join(workspaceRoot, "src", "visible.ts"), 'export const value = "skipMe"\n')
    await writeFile(join(workspaceRoot, "node_modules", "hidden.ts"), 'export const value = "skipMe"\n')
    await writeFile(join(workspaceRoot, ".git", "config"), "skipMe=true\n")
    await writeFile(join(workspaceRoot, ".worktrees", "hidden.ts"), 'export const value = "skipMe"\n')

    const result = await registry.execute({
      toolName: "search",
      args: { query: "skipMe" },
      workspaceRoot,
    })

    expect(result.output).toContain("src/visible.ts")
    expect(result.output).not.toContain("node_modules/hidden.ts")
    expect(result.output).not.toContain(".git/config")
    expect(result.output).not.toContain(".worktrees/hidden.ts")
  })

  test("search caps the number of reported matches", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "read-search-workspace-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })

    for (let index = 0; index < 25; index += 1) {
      await writeFile(
        join(workspaceRoot, "src", `match-${index}.ts`),
        `export const value${index} = "manyHit"\n`,
      )
    }

    const result = await registry.execute({
      toolName: "search",
      args: { query: "manyHit" },
      workspaceRoot,
    })

    expect(result.output).toContain("manyHit")
    expect(result.output.split("\n")).toHaveLength(21)
  })
})
