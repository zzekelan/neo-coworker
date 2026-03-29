import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
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
    await mkdir(join(workspaceRoot, "node_modules"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "visible.ts"), "export const visible = true\n")
    await writeFile(join(workspaceRoot, ".agents", "hidden.ts"), "export const hidden = true\n")
    await writeFile(join(workspaceRoot, "node_modules", "hidden.ts"), "export const hidden = true\n")

    const result = await registry.execute({
      toolName: "glob",
      args: { pattern: "**/*.ts" },
      workspaceRoot,
    })

    expect(result.output).toContain("src/visible.ts")
    expect(result.output).not.toContain(".agents/hidden.ts")
    expect(result.output).not.toContain("node_modules/hidden.ts")
  })

  test("caps the number of returned matches", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "glob-workspace-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })

    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(workspaceRoot, "src", `match-${index}.ts`), "export const value = 1\n")
    }

    const result = await registry.execute({
      toolName: "glob",
      args: { pattern: "src/*.ts" },
      workspaceRoot,
    })

    expect(result.output.split("\n")).toHaveLength(21)
    expect(result.output).toContain("... truncated after 20 matches")
  })
})
