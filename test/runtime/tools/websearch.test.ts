import { describe, expect, test } from "bun:test"
import {
  createCodesearchTool,
  createWebsearchTool,
  createToolRuntimeApi,
} from "../../../src/tool"

describe("websearch tool — metadata standardization", () => {
  test("returns resultCount, query, and truncated in metadata when results are found", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createWebsearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return "Result 1\nResult 2\nResult 3"
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "websearch",
      args: { query: "latest bun runtime features" },
      workspaceRoot: process.cwd(),
    })

    expect(result.metadata).toBeDefined()
    expect(result.metadata).toMatchObject({
      query: "latest bun runtime features",
      resultCount: expect.any(Number),
      truncated: expect.any(Boolean),
    })
  })

  test("metadata.query equals the original query string", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createWebsearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return "some result"
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "websearch",
      args: { query: "TypeScript generics tutorial" },
      workspaceRoot: process.cwd(),
    })

    expect(result.metadata?.query).toBe("TypeScript generics tutorial")
  })

  test("resultCount is greater than zero when backend returns content", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createWebsearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return "Result A\nResult B"
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "websearch",
      args: { query: "react hooks docs" },
      workspaceRoot: process.cwd(),
    })

    expect(result.metadata?.resultCount).toBeGreaterThan(0)
  })
})

describe("websearch tool — empty result friendly message", () => {
  test("output is non-empty and contains search suggestions when backend returns empty string", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createWebsearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return ""
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "websearch",
      args: { query: "xyzzy42quux nonsense term" },
      workspaceRoot: process.cwd(),
    })

    expect(result.output).toBeTruthy()
    expect(result.output.length).toBeGreaterThan(0)
    expect(result.output).toMatch(/try|rephrase|broader|different|keyword/i)
  })

  test("resultCount is zero when backend returns empty string", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createWebsearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return ""
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "websearch",
      args: { query: "xyzzy42quux" },
      workspaceRoot: process.cwd(),
    })

    expect(result.metadata?.resultCount).toBe(0)
  })
})

describe("codesearch tool — metadata standardization", () => {
  test("returns resultCount, query, and truncated in metadata when results are found", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createCodesearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return "function useState(\n  https://react.dev/reference/react/useState"
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "codesearch",
      args: { query: "useState hook React" },
      workspaceRoot: process.cwd(),
    })

    expect(result.metadata).toBeDefined()
    expect(result.metadata).toMatchObject({
      query: "useState hook React",
      resultCount: expect.any(Number),
      truncated: expect.any(Boolean),
    })
  })

  test("metadata.query equals the original query string", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createCodesearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return "some code result"
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "codesearch",
      args: { query: "zod schema parse" },
      workspaceRoot: process.cwd(),
    })

    expect(result.metadata?.query).toBe("zod schema parse")
  })

  test("output is non-empty and contains suggestions when backend returns empty string", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createCodesearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return ""
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "codesearch",
      args: { query: "xyzzy42quux unknown-lib" },
      workspaceRoot: process.cwd(),
    })

    expect(result.output).toBeTruthy()
    expect(result.output.length).toBeGreaterThan(0)
    expect(result.output).toMatch(/try|rephrase|broader|different|keyword|actual code/i)
  })
})

describe("tool descriptions — semantic distinction", () => {
  test("websearch and codesearch have distinct, non-empty descriptions", () => {
    const allow = async () => ({ decision: "allow" as const })
    const web = createWebsearchTool({ requestPermission: allow })
    const code = createCodesearchTool({ requestPermission: allow })

    expect(web.description).toBeTruthy()
    expect(code.description).toBeTruthy()
    expect(web.description).not.toBe(code.description)
  })

  test("websearch description mentions web search and natural language", () => {
    const web = createWebsearchTool({
      requestPermission: async () => ({ decision: "allow" as const }),
    })

    const desc = web.description.toLowerCase()
    expect(desc).toMatch(/web|internet|external/)
    expect(desc).toMatch(/natural.language|describe|query/)
  })

  test("codesearch description mentions code, library, or technical", () => {
    const code = createCodesearchTool({
      requestPermission: async () => ({ decision: "allow" as const }),
    })

    const desc = code.description.toLowerCase()
    expect(desc).toMatch(/code|library|api|technical/)
  })

  test("websearch has usageGuidance that distinguishes it from webfetch", () => {
    const web = createWebsearchTool({
      requestPermission: async () => ({ decision: "allow" as const }),
    })

    expect(web.usageGuidance).toBeDefined()
    expect(web.usageGuidance?.length).toBeGreaterThan(20)
  })

  test("codesearch has usageGuidance that distinguishes it from grep (local)", () => {
    const code = createCodesearchTool({
      requestPermission: async () => ({ decision: "allow" as const }),
    })

    expect(code.usageGuidance).toBeDefined()
    expect(code.usageGuidance?.length).toBeGreaterThan(20)
  })
})
