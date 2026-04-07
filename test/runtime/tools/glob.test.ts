import { mkdir, mkdtemp, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  createGlobTool,
  createToolRuntimeApi,
} from "../../../src/tool"

function createRegistry() {
  return createToolRuntimeApi({
    tools: [createGlobTool()],
  })
}

describe("glob tool", () => {
  test("finds matching files by relative glob pattern", async () => {
    const registry = createRegistry()

    const result = await registry.execute({
      toolName: "glob",
      args: { pattern: "src/*.ts" },
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    expect(result.output).toBe("src/demo.ts")
  })

  test("rejects empty or whitespace-only patterns", async () => {
    const registry = createRegistry()

    await expect(
      registry.execute({
        toolName: "glob",
        args: { pattern: "   " },
        workspaceRoot: "test/fixtures/workspaces/read-search",
      }),
    ).rejects.toThrow("Pattern must not be empty")
  })

  test("skips reserved directories when matching", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "glob-workspace-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await mkdir(join(workspaceRoot, ".agents"), { recursive: true })
    await mkdir(join(workspaceRoot, ".ncoworker"), { recursive: true })
    await mkdir(join(workspaceRoot, "node_modules"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "visible.ts"), "export const visible = true\n")
    await writeFile(join(workspaceRoot, ".agents", "hidden.ts"), "export const hidden = true\n")
    await writeFile(join(workspaceRoot, ".ncoworker", "hidden.ts"), "export const hidden = true\n")
    await writeFile(join(workspaceRoot, "node_modules", "hidden.ts"), "export const hidden = true\n")

    const result = await registry.execute({
      toolName: "glob",
      args: { pattern: "**/*.ts" },
      workspaceRoot,
    })

    expect(result.output).toContain("src/visible.ts")
    expect(result.output).not.toContain(".agents/hidden.ts")
    expect(result.output).not.toContain(".ncoworker/hidden.ts")
    expect(result.output).not.toContain("node_modules/hidden.ts")
  })

  test("caps the number of returned matches using default limit of 100", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "glob-workspace-limit-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })

    for (let index = 0; index < 120; index += 1) {
      await writeFile(join(workspaceRoot, "src", `match-${String(index).padStart(3, "0")}.ts`), "export const value = 1\n")
    }

    const result = await registry.execute({
      toolName: "glob",
      args: { pattern: "src/*.ts" },
      workspaceRoot,
    })

    const lines = result.output.split("\n")
    expect(lines).toHaveLength(101)
    expect(result.output).toContain("... truncated after 100 matches")
  })

  test("respects custom limit parameter", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "glob-workspace-custom-limit-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })

    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(workspaceRoot, "src", `match-${index}.ts`), "export const value = 1\n")
    }

    const result = await registry.execute({
      toolName: "glob",
      args: { pattern: "src/*.ts", limit: 10 },
      workspaceRoot,
    })

    const lines = result.output.split("\n")
    expect(lines).toHaveLength(11)
    expect(result.output).toContain("... truncated after 10 matches")
  })

  test("returns relative paths (not absolute)", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "glob-workspace-relpath-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "hello.ts"), "export const hello = 1\n")

    const result = await registry.execute({
      toolName: "glob",
      args: { pattern: "**/*.ts" },
      workspaceRoot,
    })

    expect(result.output).toContain("src/hello.ts")
    expect(result.output).not.toMatch(/^\//)
    for (const line of result.output.split("\n").filter(Boolean)) {
      expect(line).not.toMatch(/^\//)
    }
  })

  test("sorts results by mtime descending (most recently modified first)", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "glob-workspace-mtime-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })

    // Create files with explicitly different mtimes
    const oldest = join(workspaceRoot, "src", "oldest.ts")
    const middle = join(workspaceRoot, "src", "middle.ts")
    const newest = join(workspaceRoot, "src", "newest.ts")

    await writeFile(oldest, "export const oldest = 1\n")
    await writeFile(middle, "export const middle = 1\n")
    await writeFile(newest, "export const newest = 1\n")

    // Set specific modification times: oldest=1000s ago, middle=500s ago, newest=now
    const now = Date.now() / 1000
    await utimes(oldest, now - 1000, now - 1000)
    await utimes(middle, now - 500, now - 500)
    await utimes(newest, now - 1, now - 1)

    const result = await registry.execute({
      toolName: "glob",
      args: { pattern: "src/*.ts" },
      workspaceRoot,
    })

    const lines = result.output.split("\n").filter(Boolean)
    expect(lines[0]).toBe("src/newest.ts")
    expect(lines[1]).toBe("src/middle.ts")
    expect(lines[2]).toBe("src/oldest.ts")
  })

  test("tool definition has correct concurrency and isCompressible flags", () => {
    const tool = createGlobTool()
    expect(tool.concurrency).toBe("read-only")
    expect(tool.isCompressible).toBe(true)
  })
})
