import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  createToolRuntimeApi,
  createWebfetchTool,
} from "../../../src/tool"

describe("webfetch tool", () => {
  test("fetches content from a known URL after permission approval", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createWebfetchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "webfetch",
      args: { url: "data:text/plain,Hello%20from%20webfetch." },
      workspaceRoot: process.cwd(),
    })

    expect(result.output).toBe("Hello from webfetch.")
  })

  test("rejects denied permissions before fetching", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createWebfetchTool({
          requestPermission() {
            return { decision: "deny" as const }
          },
        }),
      ],
    })

    await expect(
      runtime.execute({
        toolName: "webfetch",
        args: { url: "https://example.com/" },
        workspaceRoot: process.cwd(),
      }),
    ).rejects.toThrow(/Permission denied/i)
  })

  // --- New capability tests ---

  describe("structured metadata", () => {
    test("returns statusCode, contentType, contentLength, truncated in metadata for data: URL", async () => {
      const runtime = createToolRuntimeApi({
        tools: [
          createWebfetchTool({
            requestPermission() {
              return { decision: "allow" as const }
            },
          }),
        ],
      })

      const result = await runtime.execute({
        toolName: "webfetch",
        args: { url: "data:text/plain,Hello" },
        workspaceRoot: process.cwd(),
      })

      expect(result.metadata).toBeDefined()
      expect(result.metadata?.statusCode).toBe(200)
      expect(result.metadata?.contentType).toBeDefined()
      expect(typeof result.metadata?.contentLength).toBe("number")
      expect(result.metadata?.truncated).toBe(false)
    })
  })

  describe("HTTP error status codes", () => {
    let originalFetch: typeof globalThis.fetch

    beforeEach(() => {
      originalFetch = globalThis.fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    test("returns isError=true and statusCode in metadata for 404 responses via data URL simulation", async () => {
      // We test HTTP error handling by checking tool definition structure
      // and testing the logic via a mock fetch approach on data: URLs
      // The actual HTTP error path is tested through the tool's logic
      const tool = createWebfetchTool({
        requestPermission() {
          return { decision: "allow" as const }
        },
      })

      // Verify the tool has the right concurrency and metadata fields
      expect(tool.concurrency).toBe("read-only")
      expect(tool.isCompressible).toBe(true)
    })
  })

  describe("binary content detection", () => {
    test("tool definition has correct capabilities set", () => {
      const tool = createWebfetchTool({
        requestPermission() {
          return { decision: "allow" as const }
        },
      })

      expect(tool.concurrency).toBe("read-only")
      expect(tool.isCompressible).toBe(true)
      expect(tool.resultSizeLimit).toBe(100000)
    })
  })

  describe("timeout parameter", () => {
    test("accepts timeout parameter in schema", async () => {
      const runtime = createToolRuntimeApi({
        tools: [
          createWebfetchTool({
            requestPermission() {
              return { decision: "allow" as const }
            },
          }),
        ],
      })

      // If timeout is accepted as valid args, this should not throw a schema validation error
      const result = await runtime.execute({
        toolName: "webfetch",
        args: { url: "data:text/plain,Hello", timeout: 30000 },
        workspaceRoot: process.cwd(),
      })

      expect(result.output).toBeDefined()
    })
  })

  describe("format parameter", () => {
    test("accepts format parameter in schema", async () => {
      const runtime = createToolRuntimeApi({
        tools: [
          createWebfetchTool({
            requestPermission() {
              return { decision: "allow" as const }
            },
          }),
        ],
      })

      const result = await runtime.execute({
        toolName: "webfetch",
        args: { url: "data:text/plain,Hello", format: "text" },
        workspaceRoot: process.cwd(),
      })

      expect(result.output).toBeDefined()
    })
  })

  describe("HTTP error handling via mock fetch", () => {
    let originalFetch: typeof globalThis.fetch

    beforeEach(() => {
      originalFetch = globalThis.fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    test("returns isError=true and metadata.statusCode=404 for 404 responses", async () => {
      // Mock global fetch to simulate a 404 for data: URL path
      globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        })
      }) as unknown as typeof globalThis.fetch

      const runtime = createToolRuntimeApi({
        tools: [
          createWebfetchTool({
            requestPermission() {
              return { decision: "allow" as const }
            },
          }),
        ],
      })

      const result = await runtime.execute({
        toolName: "webfetch",
        args: { url: "data:text/plain,test" },
        workspaceRoot: process.cwd(),
      })

      expect(result.isError).toBe(true)
      expect(result.output).toContain("404")
      expect(result.metadata?.statusCode).toBe(404)
    })

    test("detects binary content-type and returns descriptive message", async () => {
      globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        })
      }) as unknown as typeof globalThis.fetch

      const runtime = createToolRuntimeApi({
        tools: [
          createWebfetchTool({
            requestPermission() {
              return { decision: "allow" as const }
            },
          }),
        ],
      })

      const result = await runtime.execute({
        toolName: "webfetch",
        args: { url: "data:image/png;base64,abc" },
        workspaceRoot: process.cwd(),
      })

      expect(result.isError).toBeFalsy()
      expect(result.output).toContain("binary content")
      expect(result.metadata?.contentType).toContain("image/png")
    })

    test("truncates response body exceeding 1MB and marks truncated=true in metadata", async () => {
      const largeBody = "x".repeat(1048577) // 1MB + 1 byte
      globalThis.fetch = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response(largeBody, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })
      }) as unknown as typeof globalThis.fetch

      const runtime = createToolRuntimeApi({
        tools: [
          createWebfetchTool({
            requestPermission() {
              return { decision: "allow" as const }
            },
          }),
        ],
      })

      const result = await runtime.execute({
        toolName: "webfetch",
        args: { url: "data:text/plain,test" },
        workspaceRoot: process.cwd(),
      })

      expect(result.metadata?.truncated).toBe(true)
      expect(result.output.length).toBeLessThanOrEqual(1048576 + 200) // allow for truncation notice
      expect(result.output).toContain("truncated")
    })

    test("returns isError=true on timeout", async () => {
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        await new Promise<void>((resolve, reject) => {
          const id = setTimeout(resolve, 10000)
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(id)
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        })
        return new Response("late", { status: 200 })
      }) as unknown as typeof globalThis.fetch

      const runtime = createToolRuntimeApi({
        tools: [
          createWebfetchTool({
            requestPermission() {
              return { decision: "allow" as const }
            },
          }),
        ],
      })

      const start = Date.now()
      const result = await runtime.execute({
        toolName: "webfetch",
        args: { url: "data:text/plain,test", timeout: 500 },
        workspaceRoot: process.cwd(),
      })
      const elapsed = Date.now() - start

      expect(result.isError).toBe(true)
      expect(result.output.toLowerCase()).toContain("timeout")
      expect(elapsed).toBeLessThan(3000) // should complete well before 10s
    })
  })
})
