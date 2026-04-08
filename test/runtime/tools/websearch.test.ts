import { describe, expect, test } from "bun:test"
import {
  createCodesearchTool,
  createWebsearchTool,
  createToolRuntimeApi,
} from "../../../src/tool"

describe("websearch tool — metadata standardization", () => {
  test("returns standardized metadata with source attribution, query echo, result count, and truncation flag", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createWebsearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return [
              'Top web results for "latest bun runtime features"',
              "1. Bun 1.3 release notes",
              "URL: https://bun.sh/blog/bun-v1.3",
              "2. Bun runtime reference",
              "URL: https://bun.sh/docs/runtime",
              "3. Bun changelog",
              "URL: https://bun.sh/docs/project/changelog",
            ].join("\n")
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
      source: {
        type: "search-backend",
        channel: "web",
        toolName: "websearch",
      },
      query: "latest bun runtime features",
      queryEcho: "latest bun runtime features",
      resultCount: 3,
      truncated: false,
    })
  })

  test("metadata.query and metadata.queryEcho equal the original query string", async () => {
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
    expect(result.metadata?.queryEcho).toBe("TypeScript generics tutorial")
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

  test("websearch and codesearch expose the same standardized metadata keys", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createWebsearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return "1. Web result\nURL: https://example.com"
          },
        }),
        createCodesearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return "1. Code result\nURL: https://github.com/example/repo"
          },
        }),
      ],
    })

    const webResult = await runtime.execute({
      toolName: "websearch",
      args: { query: "bun runtime" },
      workspaceRoot: process.cwd(),
    })
    const codeResult = await runtime.execute({
      toolName: "codesearch",
      args: { query: "Bun.serve(" },
      workspaceRoot: process.cwd(),
    })

    expect(Object.keys(webResult.metadata ?? {}).sort()).toEqual(
      Object.keys(codeResult.metadata ?? {}).sort(),
    )
    expect(
      Object.keys((webResult.metadata?.source as Record<string, unknown>) ?? {}).sort(),
    ).toEqual(
      Object.keys((codeResult.metadata?.source as Record<string, unknown>) ?? {}).sort(),
    )
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
  test("returns standardized metadata with source attribution, query echo, result count, and truncation flag", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createCodesearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend() {
            return [
              'Top code/API results for "useState hook React"',
              "1. useState reference",
              "URL: https://react.dev/reference/react/useState",
              "2. React hooks examples",
              "URL: https://github.com/facebook/react",
            ].join("\n")
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
      source: {
        type: "search-backend",
        channel: "code",
        toolName: "codesearch",
      },
      query: "useState hook React",
      queryEcho: "useState hook React",
      resultCount: 2,
      truncated: false,
    })
  })

  test("metadata.query and metadata.queryEcho equal the original query string", async () => {
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
    expect(result.metadata?.queryEcho).toBe("zod schema parse")
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
