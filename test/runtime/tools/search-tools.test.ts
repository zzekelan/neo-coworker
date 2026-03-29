import { describe, expect, test } from "bun:test"
import {
  createCodesearchTool,
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
})
