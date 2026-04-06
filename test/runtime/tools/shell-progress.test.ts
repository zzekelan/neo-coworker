import { describe, expect, test } from "bun:test"
import { createShellTool, createToolRuntimeApi } from "../../../src/tool"

describe("shell tool progress", () => {
  test("invokes onProgress at least once while running a long command", async () => {
    const progressMessages: string[] = []
    const onProgress = (message: string) => {
      progressMessages.push(message)
    }

    const runtime = createToolRuntimeApi({
      tools: [
        createShellTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "shell",
      args: { command: "sleep 2.5" },
      workspaceRoot: process.cwd(),
      onProgress,
    })

    expect(result.isError).toBeFalsy()
    expect(progressMessages.length).toBeGreaterThanOrEqual(1)
    for (const msg of progressMessages) {
      expect(msg).toMatch(/^Running\.\.\. \d+(\.\d+)?s$/)
    }
  }, 10_000)

  test("completes without error when no onProgress callback is provided", async () => {
    const runtime = createToolRuntimeApi({
      tools: [
        createShellTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
        }),
      ],
    })

    const result = await runtime.execute({
      toolName: "shell",
      args: { command: "echo hello" },
      workspaceRoot: process.cwd(),
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toBe("hello")
  })
})
