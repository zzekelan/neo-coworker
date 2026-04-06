import { describe, expect, test } from "bun:test"
import { createShellTool, createToolRuntimeApi } from "../../../src/tool"

function makeRuntime() {
  return createToolRuntimeApi({
    tools: [
      createShellTool({
        requestPermission() {
          return { decision: "allow" as const }
        },
      }),
    ],
  })
}

describe("shell tool — structured result metadata", () => {
  test("returns exitCode=0, durationMs>0, truncated=false for a simple echo", async () => {
    const runtime = makeRuntime()
    const result = await runtime.execute({
      toolName: "shell",
      args: { command: "echo hello" },
      workspaceRoot: process.cwd(),
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("hello")
    expect(result.metadata).toBeDefined()
    expect(result.metadata?.exitCode).toBe(0)
    expect(typeof result.metadata?.durationMs).toBe("number")
    expect((result.metadata?.durationMs as number)).toBeGreaterThan(0)
    expect(result.metadata?.truncated).toBe(false)
  })

  test("returns isError=true and exitCode!=0 for a failing command", async () => {
    const runtime = makeRuntime()
    const result = await runtime.execute({
      toolName: "shell",
      args: { command: "exit 42" },
      workspaceRoot: process.cwd(),
    })

    expect(result.isError).toBe(true)
    expect(result.metadata?.exitCode).toBe(42)
    expect(typeof result.metadata?.durationMs).toBe("number")
  })
})

describe("shell tool — configurable timeout", () => {
  test("times out and returns isError=true with timeout message when command exceeds timeout", async () => {
    const runtime = makeRuntime()
    const start = Date.now()
    const result = await runtime.execute({
      toolName: "shell",
      args: { command: "sleep 30", timeoutMs: 800 },
      workspaceRoot: process.cwd(),
    })
    const elapsed = Date.now() - start

    expect(result.isError).toBe(true)
    expect(result.output.toLowerCase()).toMatch(/timeout/)
    expect(elapsed).toBeLessThan(5000)
  }, 10_000)

  test("completes normally when command finishes before timeout", async () => {
    const runtime = makeRuntime()
    const result = await runtime.execute({
      toolName: "shell",
      args: { command: "echo fast", timeoutMs: 5000 },
      workspaceRoot: process.cwd(),
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("fast")
    expect(result.metadata?.exitCode).toBe(0)
  })
})

describe("shell tool — output size cap (512KB)", () => {
  test("truncates output exceeding 512KB and sets metadata.truncated=true", async () => {
    const runtime = makeRuntime()
    const result = await runtime.execute({
      toolName: "shell",
      args: { command: "python3 -c \"import sys; sys.stdout.write('x' * (600 * 1024))\"" },
      workspaceRoot: process.cwd(),
    })

    const byteSize = Buffer.byteLength(result.output, "utf8")
    expect(byteSize).toBeLessThan(550 * 1024)
    expect(result.metadata?.truncated).toBe(true)
    expect(result.output).toContain("Output truncated")
  }, 30_000)

  test("does not truncate output within 512KB and sets metadata.truncated=false", async () => {
    const runtime = makeRuntime()
    const result = await runtime.execute({
      toolName: "shell",
      args: { command: "echo 'small output'" },
      workspaceRoot: process.cwd(),
    })

    expect(result.isError).toBeFalsy()
    expect(result.metadata?.truncated).toBe(false)
  })
})

describe("shell tool — description parameter", () => {
  test("accepts a description param without error", async () => {
    const runtime = makeRuntime()
    const result = await runtime.execute({
      toolName: "shell",
      args: { command: "echo with-description", description: "Run echo test" },
      workspaceRoot: process.cwd(),
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("with-description")
  })

  test("emits onProgress messages that include the description when provided", async () => {
    const progressMessages: string[] = []
    const runtime = createToolRuntimeApi({
      tools: [
        createShellTool({
          requestPermission() {
            return { decision: "allow" as const }
          },
        }),
      ],
    })

    await runtime.execute({
      toolName: "shell",
      args: { command: "sleep 2.5", description: "Testing description progress" },
      workspaceRoot: process.cwd(),
      onProgress: (msg) => progressMessages.push(msg),
    })

    expect(progressMessages.length).toBeGreaterThan(0)
    const hasDescription = progressMessages.some((m) => m.includes("Testing description progress"))
    expect(hasDescription).toBe(true)
  }, 15_000)
})

describe("shell tool — tool definition properties", () => {
  test("has timeout=120000, concurrency=mutating, isCompressible=false on the definition", () => {
    const tool = createShellTool({
      requestPermission() {
        return { decision: "allow" as const }
      },
    })

    expect(tool.timeout).toBe(120_000)
    expect(tool.concurrency).toBe("mutating")
    expect(tool.isCompressible).toBe(false)
  })
})
