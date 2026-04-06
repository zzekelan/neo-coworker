import { describe, expect, test } from "bun:test"
import {
  createCodesearchTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createShellTool,
  createWebfetchTool,
  createWebsearchTool,
  createWriteTool,
  type ToolDefinition,
  type ToolExecutionResult,
} from "../../../src/tool"

describe("tool contract compatibility", () => {
  test("ToolDefinition works without new fields", async () => {
    const tool = {
      name: "demo",
      description: "demo tool",
      async execute(_input: { toolName: string; args: unknown; workspaceRoot: string }) {
        return { output: "ok" }
      },
    } satisfies ToolDefinition

    const runtime = {
      async execute(input: { toolName: string; args: unknown; workspaceRoot: string }) {
        if (input.toolName !== tool.name) {
          throw new Error("Unexpected tool")
        }

        return await tool.execute({
          toolName: input.toolName,
          args: input.args,
          workspaceRoot: input.workspaceRoot,
        })
      },
    }

    const result = await runtime.execute({
      toolName: "demo",
      args: {},
      workspaceRoot: process.cwd(),
    })

    expect(result.output).toBe("ok")
  })

  test("ToolDefinition works with all new fields", () => {
    const tool = {
      name: "demo",
      description: "demo tool",
      concurrency: "read-only",
      isConcurrencySafe: () => true,
      usageGuidance: "Use sparingly",
      resultSizeLimit: 1_024,
      isCompressible: true,
      timeout: 250,
      async execute() {
        return { output: "ok", metadata: { count: 1 } }
      },
    } satisfies ToolDefinition

    expect(tool.concurrency).toBe("read-only")
    expect(tool.usageGuidance).toContain("sparingly")
  })

  test("ToolExecutionResult works with output only", () => {
    const result = { output: "text" } satisfies ToolExecutionResult

    expect(result.output).toBe("text")
  })

  test("ToolExecutionResult works with error and metadata", () => {
    const result = {
      output: "text",
      isError: true,
      metadata: { path: "src/demo.ts" },
    } satisfies ToolExecutionResult

    expect(result.isError).toBe(true)
    expect(result.metadata).toEqual({ path: "src/demo.ts" })
  })

  test("read-type builtins expose read-only concurrency defaults", () => {
    const allow = async () => ({ decision: "allow" as const })

    const tools: ToolDefinition[] = [
      createReadTool(),
      createGlobTool(),
      createGrepTool(),
      createWebfetchTool({ requestPermission: allow }),
      createWebsearchTool({ requestPermission: allow }),
      createCodesearchTool({ requestPermission: allow }),
    ]

    for (const tool of tools) {
      expect(tool.concurrency).toBe("read-only")
      expect(tool.isCompressible).toBe(true)
    }
  })

  test("mutating builtins expose mutating concurrency defaults", () => {
    const allow = async () => ({ decision: "allow" as const })

    const tools: ToolDefinition[] = [
      createWriteTool({ requestPermission: allow }),
      createEditTool({ requestPermission: allow }),
      createShellTool({ requestPermission: allow }),
    ]

    for (const tool of tools) {
      expect(tool.concurrency).toBe("mutating")
      expect(tool.isCompressible).toBe(false)
    }
  })
})
