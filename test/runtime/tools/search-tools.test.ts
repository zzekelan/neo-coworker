import { describe, expect, test } from "bun:test"
import {
  createCodesearchTool,
  createPublicSearchToolBackend,
  createToolRuntimeApi,
  createWebsearchTool,
} from "../../../src/tool"

describe("search tools", () => {
  test("websearch sends approved queries through the shared backend", async () => {
    const requests: Array<{ toolName: string; query: string }> = []
    const runtime = createToolRuntimeApi({
      tools: [
        createWebsearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
          async searchBackend(input) {
            requests.push({
              toolName: input.toolName,
              query: input.query,
            })
            return "web result body"
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "websearch",
      args: { query: "latest bun release" },
      workspaceRoot: process.cwd(),
    })

    expect(result.output).toBe("web result body")
    expect(requests).toEqual([
      {
        toolName: "websearch",
        query: "latest bun release",
      },
    ])
  })

  test("codesearch surfaces a setup error when the backend is missing", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createCodesearchTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
        }),
      ],
    })

    await expect(
      runtime.execute({
        toolName: "codesearch",
        args: { query: "react useEffectEvent" },
        workspaceRoot: process.cwd(),
      }),
    ).rejects.toThrow("Setup error: SEARCH_BACKEND_URL is required to enable codesearch")
  })

  test("permission denial short-circuits search backend usage", async () => {
    let calls = 0
    const runtime = createToolRuntimeApi({
      tools: [
        createWebsearchTool({
          requestPermission() {
            return { decision: "deny" as const }
          },
          searchBackend: async () => {
            calls += 1
            return "should not run"
          },
        }),
      ],
    })

    await expect(
      runtime.execute({
        toolName: "websearch",
        args: { query: "denied request" },
        workspaceRoot: process.cwd(),
      }),
    ).rejects.toThrow(/Permission denied/i)
    expect(calls).toBe(0)
  })

  test("public websearch fallback formats instant-answer results without custom backend config", async () => {
    const backend = createPublicSearchToolBackend({
      async fetchImpl() {
        return new Response(
          [
            'event: message',
            'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Top web results for \\"Alan Turing\\"\\n1. Alan Turing\\nURL: https://en.wikipedia.org/wiki/Alan_Turing"}]}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        )
      },
    })

    await expect(
      backend({
        toolName: "websearch",
        query: "Alan Turing",
      }),
    ).resolves.toContain('Top web results for "Alan Turing"')
  })

  test("public codesearch fallback formats MDN documents without custom backend config", async () => {
    const backend = createPublicSearchToolBackend({
      async fetchImpl() {
        return new Response(
          [
            'data: {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"URLSearchParams lets you work with query strings.\\nhttps://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams"}]}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        )
      },
    })

    await expect(
      backend({
        toolName: "codesearch",
        query: "URLSearchParams",
      }),
    ).resolves.toContain("https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams")
  })

  test("public websearch falls back to DuckDuckGo when Exa returns an HTTP error", async () => {
    const requestedUrls: string[] = []
    const backend = createPublicSearchToolBackend({
      async fetchImpl(input) {
        const url = typeof input === "string" ? input : input.toString()
        requestedUrls.push(url)

        if (url === "https://mcp.exa.ai/mcp") {
          return new Response("upstream unavailable", {
            status: 500,
            headers: {
              "content-type": "text/plain",
            },
          })
        }

        if (url.startsWith("https://api.duckduckgo.com/")) {
          return new Response(
            JSON.stringify({
              Heading: "Alan Turing",
              AbstractText: "Alan Turing was born on 23 June 1912.",
              AbstractURL: "https://en.wikipedia.org/wiki/Alan_Turing",
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          )
        }

        throw new Error(`Unexpected fetch URL: ${url}`)
      },
    })

    await expect(
      backend({
        toolName: "websearch",
        query: "Alan Turing birth date",
      }),
    ).resolves.toContain("23 June 1912")
    expect(requestedUrls).toEqual([
      "https://mcp.exa.ai/mcp",
      expect.stringContaining("https://api.duckduckgo.com/"),
    ])
  })

  test("public codesearch falls back to MDN when Exa returns an HTTP error", async () => {
    const requestedUrls: string[] = []
    const backend = createPublicSearchToolBackend({
      async fetchImpl(input) {
        const url = typeof input === "string" ? input : input.toString()
        requestedUrls.push(url)

        if (url === "https://mcp.exa.ai/mcp") {
          return new Response("upstream unavailable", {
            status: 500,
            headers: {
              "content-type": "text/plain",
            },
          })
        }

        if (url.startsWith("https://developer.mozilla.org/api/v1/search")) {
          return new Response(
            JSON.stringify({
              documents: [
                {
                  title: "URLSearchParams",
                  mdn_url: "/en-US/docs/Web/API/URLSearchParams",
                  summary: "URLSearchParams lets you work with the query string of a URL.",
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          )
        }

        throw new Error(`Unexpected fetch URL: ${url}`)
      },
    })

    await expect(
      backend({
        toolName: "codesearch",
        query: "URLSearchParams",
      }),
    ).resolves.toContain("https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams")
    expect(requestedUrls).toEqual([
      "https://mcp.exa.ai/mcp",
      expect.stringContaining("https://developer.mozilla.org/api/v1/search"),
    ])
  })

  test("public search backend parses multi-line SSE data frames", async () => {
    const backend = createPublicSearchToolBackend({
      async fetchImpl() {
        return new Response(
          [
            "event: message",
            'data: {"jsonrpc":"2.0",',
            'data: "result":{"content":[{"type":"text","text":"Multi-line SSE result."}]}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        )
      },
    })

    await expect(
      backend({
        toolName: "websearch",
        query: "split sse",
      }),
    ).resolves.toBe("Multi-line SSE result.")
  })

  test("public search backend also accepts plain JSON MCP responses", async () => {
    const backend = createPublicSearchToolBackend({
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {
              content: [
                {
                  type: "text",
                  text: "Plain JSON response from Exa MCP.",
                },
              ],
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        )
      },
    })

    await expect(
      backend({
        toolName: "websearch",
        query: "plain json",
      }),
    ).resolves.toBe("Plain JSON response from Exa MCP.")
  })

  test("public search backend surfaces JSON-RPC errors instead of pretending no results were found", async () => {
    const backend = createPublicSearchToolBackend({
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "rate limited",
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        )
      },
    })

    await expect(
      backend({
        toolName: "websearch",
        query: "x",
      }),
    ).rejects.toThrow("Setup error: Public search backend failed (-32000): rate limited")
  })
})
