import { describe, expect, test } from "bun:test"
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
})
