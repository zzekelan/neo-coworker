import { describe, expect, test } from "bun:test"
import { createReadTool } from "../../../src/runtime/tools/read"
import { createToolRegistry } from "../../../src/runtime/tools/registry"
import { createSearchTool } from "../../../src/runtime/tools/search"

describe("read-only tools", () => {
  test("reads files relative to the workspace root", async () => {
    const registry = createToolRegistry([createReadTool(), createSearchTool()])

    const result = await registry.execute({
      toolName: "read",
      args: { path: "README.md" },
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    expect(result.output).toContain("demo workspace")
  })

  test("search finds matching files and line snippets", async () => {
    const registry = createToolRegistry([createReadTool(), createSearchTool()])

    const result = await registry.execute({
      toolName: "search",
      args: { query: "helloDemo" },
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    expect(result.output).toContain("src/demo.ts")
    expect(result.output).toContain("helloDemo")
  })
})
