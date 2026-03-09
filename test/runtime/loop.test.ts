import { cp, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createFakeProvider } from "../../src/providers/fake"
import { createOpenAICompatibleProvider } from "../../src/providers/openai-compatible"
import { createOpenAIProvider } from "../../src/providers/openai"
import type { ProviderTurnRequest } from "../../src/providers/types"
import { createRuntime } from "../../src/runtime/runtime"

async function createWorkspaceCopy() {
  const tempRoot = await mkdtemp(join(tmpdir(), "runtime-loop-"))
  const workspaceRoot = join(tempRoot, "workspace")

  await cp("test/fixtures/workspaces/read-search", workspaceRoot, { recursive: true })

  return workspaceRoot
}

describe("agent loop", () => {
  test("streams assistant text, executes tools, and completes the run", async () => {
    let providerRequest: ProviderTurnRequest | undefined
    const runtime = createRuntime({
      provider: createFakeProvider({
        onRequest(request) {
          providerRequest = request
        },
        events: [
          { type: "text.delta", text: "Looking at the file." },
          {
            type: "tool.call",
            callId: "call_1",
            name: "read",
            inputText: '{"path":"README.md"}',
          },
          { type: "text.delta", text: "Done." },
        ],
      }),
    })

    const handle = await runtime.run({
      prompt: "Inspect README.md",
      cwd: "test/fixtures/workspaces/read-search",
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    const events = []
    for await (const event of handle.events) {
      events.push(event)
    }

    const toolNames = providerRequest?.tools.map((tool) => (tool as { name: string }).name) ?? []

    expect(toolNames).toContain("read")
    expect(toolNames).toContain("search")

    const eventTypes = events.map((event) => event.type)
    expect(eventTypes).toContain("run.started")
    expect(eventTypes).toContain("tool.call.completed")
    expect(eventTypes.at(-1)).toBe("run.completed")

    expect(events.find((event) => event.type === "tool.call.completed")).toMatchObject({
      type: "tool.call.completed",
      callId: "call_1",
      name: "read",
      output: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
    })
  })

  test("returns the handle before the provider stream completes", async () => {
    let releaseStream!: () => void
    const streamBlocked = new Promise<void>((resolve) => {
      releaseStream = resolve
    })

    const runtime = createRuntime({
      provider: {
        async *streamTurn() {
          yield { type: "text.delta", text: "Partial response" }
          await streamBlocked
        },
      },
    })

    const timeout = Symbol("timeout")
    const handleOrTimeout = await Promise.race([
      runtime.run({
        prompt: "Inspect README.md",
        cwd: "test/fixtures/workspaces/read-search",
        workspaceRoot: "test/fixtures/workspaces/read-search",
      }),
      new Promise<typeof timeout>((resolve) => {
        setTimeout(() => resolve(timeout), 25)
      }),
    ])

    expect(handleOrTimeout).not.toBe(timeout)

    if (handleOrTimeout === timeout) {
      throw new Error("run() did not return before the provider stream completed")
    }

    const iterator = handleOrTimeout.events[Symbol.asyncIterator]()
    const firstEventOrTimeout = await Promise.race([
      iterator.next(),
      new Promise<typeof timeout>((resolve) => {
        setTimeout(() => resolve(timeout), 25)
      }),
    ])

    expect(firstEventOrTimeout).not.toBe(timeout)

    if (firstEventOrTimeout === timeout || firstEventOrTimeout.done) {
      throw new Error("Expected a live event before the provider stream finished")
    }

    expect(firstEventOrTimeout.value.type).toBe("run.started")

    releaseStream()

    const eventTypes = [firstEventOrTimeout.value.type]
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      eventTypes.push(next.value.type)
    }

    expect(eventTypes.at(-1)).toBe("run.completed")
  })

  test("emits run.failed when the provider turn throws", async () => {
    const runtime = createRuntime({
      provider: {
        async *streamTurn() {
          yield { type: "text.delta", text: "Starting" as const }
          throw new Error("provider exploded")
        },
      },
    })

    const handle = await runtime.run({
      prompt: "Inspect README.md",
      cwd: "test/fixtures/workspaces/read-search",
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    const events = []
    for await (const event of handle.events) {
      events.push(event)
    }

    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      error: "provider exploded",
    })
  })

  test("emits run.cancelled when cancelled during the provider turn", async () => {
    const runtime = createRuntime({
      provider: {
        async *streamTurn(request: ProviderTurnRequest) {
          yield { type: "text.delta", text: "Starting" }

          await new Promise<void>((_, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted")
                error.name = "AbortError"
                reject(error)
              },
              { once: true },
            )
          })
        },
      },
    })

    const handle = await runtime.run({
      prompt: "Inspect README.md",
      cwd: "test/fixtures/workspaces/read-search",
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    const iterator = handle.events[Symbol.asyncIterator]()
    const firstEvent = await iterator.next()
    expect(firstEvent.done).toBe(false)
    expect(firstEvent.value.type).toBe("run.started")

    handle.cancel()

    const eventTypes = [firstEvent.value.type]
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      eventTypes.push(next.value.type)
    }

    expect(eventTypes.at(-1)).toBe("run.cancelled")
  })

  test("emits permission requests and resumes tool execution after a response", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const runtime = createRuntime({
      provider: createFakeProvider({
        events: [
          {
            type: "tool.call",
            callId: "call_1",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          },
        ],
      }),
    })

    const handle = await runtime.run({
      prompt: "Write notes.txt with hello",
      cwd: workspaceRoot,
      workspaceRoot,
    })

    const iterator = handle.events[Symbol.asyncIterator]()
    const observedTypes: string[] = []

    while (true) {
      const next = await iterator.next()
      if (next.done) {
        break
      }

      observedTypes.push(next.value.type)

      if (next.value.type === "permission.requested") {
        expect(next.value).toMatchObject({
          type: "permission.requested",
          toolName: "write",
          reason: "write notes.txt",
        })

        handle.respondPermission({
          requestId: next.value.requestId,
          decision: "allow",
        })
      }
    }

    expect(observedTypes).toContain("permission.requested")
    expect(observedTypes).toContain("tool.call.completed")
    expect(observedTypes.at(-1)).toBe("run.completed")
    expect(await Bun.file(join(workspaceRoot, "notes.txt")).text()).toBe("hello")
  })

  test("emits run.cancelled when cancelled while waiting for permission", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const runtime = createRuntime({
      provider: createFakeProvider({
        events: [
          {
            type: "tool.call",
            callId: "call_1",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          },
        ],
      }),
    })

    const handle = await runtime.run({
      prompt: "Write notes.txt with hello",
      cwd: workspaceRoot,
      workspaceRoot,
    })

    const iterator = handle.events[Symbol.asyncIterator]()
    const eventTypes: string[] = []

    while (true) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<symbol>((resolve) => {
          setTimeout(() => resolve(Symbol.for("timeout")), 25)
        }),
      ])

      if (typeof next === "symbol") {
        throw new Error("Expected runtime cancellation to finish the permission-gated run")
      }

      if (next.done) {
        break
      }

      eventTypes.push(next.value.type)

      if (next.value.type === "permission.requested") {
        handle.cancel()
      }
    }

    expect(eventTypes).toContain("permission.requested")
    expect(eventTypes.at(-1)).toBe("run.cancelled")
    expect(await Bun.file(join(workspaceRoot, "notes.txt")).exists()).toBe(false)
  })

  test("executes one tool call when openai streams arguments across multiple chunks", async () => {
    const provider = createOpenAIProvider({
      model: "gpt-5",
      client: {
        responses: {
          stream: async function* () {
            yield {
              type: "response.output_item.added",
              item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "read",
                arguments: "",
              },
              output_index: 0,
              sequence_number: 0,
            }
            yield {
              type: "response.function_call_arguments.delta",
              item_id: "fc_1",
              output_index: 0,
              sequence_number: 1,
              delta: "{\"path\":",
            }
            yield {
              type: "response.function_call_arguments.delta",
              item_id: "fc_1",
              output_index: 0,
              sequence_number: 2,
              delta: "\"README.md\"}",
            }
            yield {
              type: "response.function_call_arguments.done",
              item_id: "fc_1",
              output_index: 0,
              sequence_number: 3,
              arguments: "{\"path\":\"README.md\"}",
            }
          },
        },
      },
    })

    const runtime = createRuntime({ provider })
    const handle = await runtime.run({
      prompt: "Inspect README.md",
      cwd: "test/fixtures/workspaces/read-search",
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    const events = []
    for await (const event of handle.events) {
      events.push(event)
    }

    expect(events.filter((event) => event.type === "tool.call.completed")).toEqual([
      {
        type: "tool.call.completed",
        callId: "call_1",
        name: "read",
        output: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
      },
    ])
    expect(events.at(-1)).toMatchObject({ type: "run.completed" })
  })

  test("executes one tool call when openai-compatible streams tool calls across multiple chunks", async () => {
    let receivedBody: unknown
    let receivedOptions: unknown
    const provider = createOpenAICompatibleProvider({
      model: "kimi-k2.5",
      client: {
        chat: {
          completions: {
            create: async function* (body, options) {
              receivedBody = body
              receivedOptions = options

              yield {
                id: "chatcmpl_1",
                object: "chat.completion.chunk",
                created: 1,
                model: "kimi-k2.5",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          type: "function",
                          function: {
                            name: "read",
                            arguments: "{\"path\":",
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              }
              yield {
                id: "chatcmpl_1",
                object: "chat.completion.chunk",
                created: 1,
                model: "kimi-k2.5",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: {
                            arguments: "\"README.md\"}",
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              }
            },
          },
        },
      },
    })

    const runtime = createRuntime({ provider })
    const handle = await runtime.run({
      prompt: "Inspect README.md",
      cwd: "test/fixtures/workspaces/read-search",
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    const events = []
    for await (const event of handle.events) {
      events.push(event)
    }

    expect(receivedBody).toMatchObject({
      model: "kimi-k2.5",
      tools: expect.any(Array),
      stream: true,
    })
    expect(receivedOptions).toMatchObject({ signal: expect.any(AbortSignal) })
    expect(events.filter((event) => event.type === "tool.call.completed")).toEqual([
      {
        type: "tool.call.completed",
        callId: "call_1",
        name: "read",
        output: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
      },
    ])
    expect(events.at(-1)).toMatchObject({ type: "run.completed" })
  })
})
