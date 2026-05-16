import { describe, expect, test } from "bun:test"
import {
  classifyToolCalls,
  executeToolBatch,
  type ConcurrentToolCall,
  type ConcurrentToolDefinition,
} from "../../src/orchestration/infrastructure/tool-executor"
import {
  TOOL_RECOVERABLE_UNKNOWN_METADATA_KEY,
  TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY,
} from "../../src/orchestration"

function createDelay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function createAbortError(message = "Operation aborted") {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

type SafeInput = { safe?: boolean }

describe("tool executor", () => {
  test("classifies tool calls with predicate priority and mutating default", () => {
    const calls: ConcurrentToolCall[] = [
      { callId: "call_1", toolName: "dynamic_read", args: { safe: true } },
      { callId: "call_2", toolName: "dynamic_write", args: { safe: false } },
      { callId: "call_3", toolName: "static_read", args: {} },
      { callId: "call_4", toolName: "default_mutating", args: {} },
    ]
    const registry: ConcurrentToolDefinition[] = [
      {
        name: "dynamic_read",
        description: "Dynamic classifier overrides static mutating",
        concurrency: "mutating",
        isConcurrencySafe(input: unknown) {
          return Boolean((input as SafeInput).safe)
        },
        execute: async () => ({ output: "unused" }),
      },
      {
        name: "dynamic_write",
        description: "Dynamic classifier overrides static read-only",
        concurrency: "read-only",
        isConcurrencySafe(input: unknown) {
          return Boolean((input as SafeInput).safe)
        },
        execute: async () => ({ output: "unused" }),
      },
      {
        name: "static_read",
        description: "Static read-only tool",
        concurrency: "read-only",
        execute: async () => ({ output: "unused" }),
      },
      {
        name: "default_mutating",
        description: "No concurrency metadata",
        execute: async () => ({ output: "unused" }),
      },
    ]

    const batch = classifyToolCalls(calls, registry)

    expect(batch.readOnly.map((call: { toolName: string }) => call.toolName)).toEqual([
      "dynamic_read",
      "static_read",
    ])
    expect(batch.mutating.map((call: { toolName: string }) => call.toolName)).toEqual([
      "dynamic_write",
      "default_mutating",
    ])
    expect(batch.calls.map((call: { concurrency: string }) => call.concurrency)).toEqual([
      "read-only",
      "mutating",
      "read-only",
      "mutating",
    ])
  })

  test("executes read-only tools in parallel before serial mutating tools", async () => {
    const timeline: string[] = []
    const calls: ConcurrentToolCall[] = [
      { callId: "call_1", toolName: "read_a", args: {} },
      { callId: "call_2", toolName: "read_b", args: {} },
      { callId: "call_3", toolName: "write_a", args: {} },
      { callId: "call_4", toolName: "write_b", args: {} },
    ]
    const tools: ConcurrentToolDefinition[] = [
      {
        name: "read_a",
        description: "Read only A",
        concurrency: "read-only",
        async execute(input: { toolName: string }) {
          timeline.push(`start:${input.toolName}`)
          await createDelay(100)
          timeline.push(`end:${input.toolName}`)
          return { output: input.toolName }
        },
      },
      {
        name: "read_b",
        description: "Read only B",
        concurrency: "read-only",
        async execute(input: { toolName: string }) {
          timeline.push(`start:${input.toolName}`)
          await createDelay(100)
          timeline.push(`end:${input.toolName}`)
          return { output: input.toolName }
        },
      },
      {
        name: "write_a",
        description: "Mutating A",
        concurrency: "mutating",
        async execute(input: { toolName: string }) {
          timeline.push(`start:${input.toolName}`)
          await createDelay(10)
          timeline.push(`end:${input.toolName}`)
          return { output: input.toolName }
        },
      },
      {
        name: "write_b",
        description: "Mutating B",
        concurrency: "mutating",
        async execute(input: { toolName: string }) {
          timeline.push(`start:${input.toolName}`)
          await createDelay(10)
          timeline.push(`end:${input.toolName}`)
          return { output: input.toolName }
        },
      },
    ]

    const batch = classifyToolCalls(calls, tools)
    const startedAt = Date.now()
    const results = await executeToolBatch(
      batch,
      tools,
      "/workspace",
      new AbortController().signal,
    )
    const elapsed = Date.now() - startedAt

    expect(elapsed).toBeLessThan(220)
    expect(results.map((result: { output: string }) => result.output)).toEqual([
      "read_a",
      "read_b",
      "write_a",
      "write_b",
    ])
    expect(timeline.indexOf("end:read_a")).toBeLessThan(timeline.indexOf("start:write_a"))
    expect(timeline.indexOf("end:read_b")).toBeLessThan(timeline.indexOf("start:write_a"))
    expect(timeline.indexOf("end:write_a")).toBeLessThan(timeline.indexOf("start:write_b"))
  })

  test("returns results in original call order regardless of completion order", async () => {
    const calls: ConcurrentToolCall[] = [
      { callId: "call_1", toolName: "tool_0", args: {} },
      { callId: "call_2", toolName: "tool_1", args: {} },
      { callId: "call_3", toolName: "tool_2", args: {} },
    ]
    const tools: ConcurrentToolDefinition[] = [
      {
        name: "tool_0",
        description: "Completes second",
        concurrency: "read-only",
        async execute() {
          await createDelay(30)
          return { output: "tool_0" }
        },
      },
      {
        name: "tool_1",
        description: "Completes first",
        concurrency: "read-only",
        async execute() {
          await createDelay(10)
          return { output: "tool_1" }
        },
      },
      {
        name: "tool_2",
        description: "Completes third",
        concurrency: "read-only",
        async execute() {
          await createDelay(50)
          return { output: "tool_2" }
        },
      },
    ]

    const results = await executeToolBatch(
      classifyToolCalls(calls, tools),
      tools,
      "/workspace",
      new AbortController().signal,
    )

    expect(results.map((result: { output: string }) => result.output)).toEqual([
      "tool_0",
      "tool_1",
      "tool_2",
    ])
  })

  test("returns recoverable error results for model-emitted unknown tools", async () => {
    const calls: ConcurrentToolCall[] = [
      { callId: "call_unknown", toolName: "shell_cmd", args: {} },
    ]
    const tools: ConcurrentToolDefinition[] = [
      {
        name: "read",
        description: "Read files",
        concurrency: "read-only",
        execute: async () => ({ output: "unused" }),
      },
      {
        name: "glob",
        description: "List files",
        concurrency: "read-only",
        execute: async () => ({ output: "unused" }),
      },
    ]

    const results = await executeToolBatch(
      classifyToolCalls(calls, tools),
      tools,
      "/workspace",
      new AbortController().signal,
    )

    expect(results).toEqual([
      {
        output: "Tool 'shell_cmd' is not available. Allowed tools: read, glob. Use one of the allowed tools instead.",
        isError: true,
        errorCode: "UNKNOWN_TOOL",
        metadata: {
          [TOOL_RECOVERABLE_UNKNOWN_METADATA_KEY]: true,
          [TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY]: ["read", "glob"],
        },
      },
    ])
  })

  test("recovers retired edit calls by pointing at the allowed apply_patch surface", async () => {
    const calls: ConcurrentToolCall[] = [
      { callId: "call_edit", toolName: "edit", args: {} },
    ]
    const tools: ConcurrentToolDefinition[] = [
      {
        name: "read",
        description: "Read files",
        concurrency: "read-only",
        execute: async () => ({ output: "unused" }),
      },
      {
        name: "apply_patch",
        description: "Apply patches",
        concurrency: "mutating",
        execute: async () => ({ output: "unused" }),
      },
      {
        name: "write",
        description: "Write files",
        concurrency: "mutating",
        execute: async () => ({ output: "unused" }),
      },
    ]

    const results = await executeToolBatch(
      classifyToolCalls(calls, tools),
      tools,
      "/workspace",
      new AbortController().signal,
    )

    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.output).toContain("Tool 'edit' is not available")
    expect(results[0]?.output).toContain("apply_patch")
    expect(results[0]?.metadata?.[TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY]).toEqual([
      "read",
      "apply_patch",
      "write",
    ])
  })

  test("keeps inconsistent executor configuration fatal", async () => {
    const calls: ConcurrentToolCall[] = [
      { callId: "call_read", toolName: "read", args: {} },
    ]
    const registry: ConcurrentToolDefinition[] = [
      {
        name: "read",
        description: "Read files",
        concurrency: "read-only",
        execute: async () => ({ output: "unused" }),
      },
    ]

    await expect(
      executeToolBatch(
        classifyToolCalls(calls, registry),
        [],
        "/workspace",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unknown tool: read")
  })

  test("propagates abort to all concurrent executions", async () => {
    const abortSeenBy: string[] = []
    const controller = new AbortController()
    const calls: ConcurrentToolCall[] = [
      { callId: "call_1", toolName: "read_a", args: {} },
      { callId: "call_2", toolName: "read_b", args: {} },
      { callId: "call_3", toolName: "read_c", args: {} },
    ]
    const tools: ConcurrentToolDefinition[] = ["read_a", "read_b", "read_c"].map((name) => ({
      name,
      description: `Concurrent ${name}`,
      concurrency: "read-only" as const,
      execute(input: { signal?: AbortSignal }) {
        return new Promise((_, reject) => {
          const onAbort = () => {
            abortSeenBy.push(name)
            reject(createAbortError(`${name} aborted`))
          }

          input.signal?.addEventListener("abort", onAbort, { once: true })
          setTimeout(() => {
            input.signal?.removeEventListener("abort", onAbort)
            reject(new Error(`${name} should have been aborted`))
          }, 200)
        })
      },
    }))

    const promise = executeToolBatch(
      classifyToolCalls(calls, tools),
      tools,
      "/workspace",
      controller.signal,
    )

    setTimeout(() => {
      controller.abort(createAbortError())
    }, 20)

    await expect(promise).rejects.toThrow("aborted")
    expect(abortSeenBy.sort()).toEqual(["read_a", "read_b", "read_c"])
  })
})
