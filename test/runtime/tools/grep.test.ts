import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  createGrepTool,
  createToolRuntimeApi,
} from "../../../src/tool"

function createRegistry() {
  return createToolRuntimeApi({
    tools: [createGrepTool()],
  })
}

describe("grep tool", () => {
  test("finds matching lines and line snippets", async () => {
    const registry = createRegistry()

    const result = await registry.execute({
      toolName: "grep",
      args: { query: "helloDemo" },
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    expect(result.output).toContain("src/demo.ts")
    expect(result.output).toContain("helloDemo")
  })

  test("rejects empty or whitespace-only queries", async () => {
    const registry = createRegistry()

    await expect(
      registry.execute({
        toolName: "grep",
        args: { query: "   " },
        workspaceRoot: "test/fixtures/workspaces/read-search",
      }),
    ).rejects.toThrow("Query must not be empty")
  })

  test("skips reserved directories and caps matches", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-workspace-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await mkdir(join(workspaceRoot, ".agents"), { recursive: true })

    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(workspaceRoot, "src", `match-${index}.ts`), `const value = "manyHit"\n`)
    }

    await writeFile(join(workspaceRoot, ".agents", "hidden.ts"), 'const value = "manyHit"\n')

    const result = await registry.execute({
      toolName: "grep",
      args: { query: "manyHit" },
      workspaceRoot,
    })

    expect(result.output).not.toContain(".agents/hidden.ts")
    expect(result.output).toContain("src/match-0.ts")
    expect(result.output).toContain("... truncated after 20 matches")
  })
})
