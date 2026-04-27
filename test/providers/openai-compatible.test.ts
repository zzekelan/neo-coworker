import { describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { z } from "zod"
import { createOpenAICompatibleProvider } from "../../src/model"
import { createEditTool } from "../../src/tool"

type OpenAICompatibleRequest = OpenAI.Chat.ChatCompletionCreateParamsStreaming & {
  reasoning_split?: boolean
}
type OpenAIRequestOptions = OpenAI.RequestOptions
type OpenAICompatibleChunkStream =
  | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
  | Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>
type OpenAICompatibleCreate = (
  body: OpenAICompatibleRequest,
  options?: OpenAIRequestOptions,
) => OpenAICompatibleChunkStream

type ProviderInput = Parameters<typeof createOpenAICompatibleProvider>[0]

function createMockOpenAICompatibleClient(create: OpenAICompatibleCreate): OpenAI {
  return {
    chat: {
      completions: {
        create: create as unknown as OpenAI["chat"]["completions"]["create"],
      },
    },
  } as OpenAI
}

function createOpenAICompatibleChunk(partial: Record<string, unknown>): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: "chatcmpl_fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "kimi-k2.5",
    choices: [
      {
        index: 0,
        finish_reason: null,
        delta: partial,
      },
    ],
  } as OpenAI.Chat.ChatCompletionChunk
}

function createProvider(input: ProviderInput) {
  return createOpenAICompatibleProvider(input)
}

function createDeepSeekToolReplayFixture() {
  const reasoningText = "Need to preserve DeepSeek reasoning before replaying the read tool call."

  return {
    model: "deepseek-reasoner",
    requiredReasoningField: "reasoning_content" as const,
    reasoningText,
    messages: [
      {
        role: "user" as const,
        parts: [{ type: "text" as const, text: "inspect README.md" }],
      },
      {
        role: "assistant" as const,
        parts: [
          {
            type: "reasoning" as const,
            text: reasoningText,
          },
          {
            type: "tool_call" as const,
            callId: "call_deepseek_read",
            toolName: "read",
            inputText: '{"path":"README.md"}',
          },
        ],
      },
    ],
  }
}

function assertOpenAICompatibleToolReplayFixtureRequiresReasoning(
  input: ReturnType<typeof createDeepSeekToolReplayFixture>,
) {
  const assistantWithToolCall = input.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => part.type === "tool_call"),
  )
  const reasoningPart = assistantWithToolCall?.parts.find((part) => part.type === "reasoning")

  expect(input.requiredReasoningField).toBe("reasoning_content")
  expect(reasoningPart).toEqual({
    type: "reasoning",
    text: input.reasoningText,
  })
  expect(input.reasoningText.trim().length).toBeGreaterThan(0)
}

function createDoubaoUnknownToolCallFixture() {
  const modelEmittedToolCalls = [
    {
      callId: "call_doubao_shell_cmd",
      name: "shell_cmd",
      inputText: '{"cmd":"pwd"}',
    },
    {
      callId: "call_doubao_list",
      name: "list",
      inputText: '{"path":"."}',
    },
  ]

  return {
    providerFamily: "doubao-compatible",
    scope: "model-emitted" as const,
    availableToolNames: ["read", "grep", "glob"],
    modelEmittedToolCalls,
    expectedToolResultErrors: modelEmittedToolCalls.map((call) => ({
      callId: call.callId,
      toolName: call.name,
      output: `Unknown tool: ${call.name}`,
      isError: true,
    })),
    internalExecutorConfigBugsRemainFatal: true,
  }
}

function assertDoubaoUnknownToolFixture(input: ReturnType<typeof createDoubaoUnknownToolCallFixture>) {
  const availableToolNames = new Set(input.availableToolNames)

  expect(input.scope).toBe("model-emitted")
  expect(input.modelEmittedToolCalls.every((call) => !availableToolNames.has(call.name))).toBe(true)
  expect(input.modelEmittedToolCalls.every((call) => call.inputText.trim().startsWith("{"))).toBe(true)
  expect(input.expectedToolResultErrors).toEqual(
    input.modelEmittedToolCalls.map((call) => ({
      callId: call.callId,
      toolName: call.name,
      output: `Unknown tool: ${call.name}`,
      isError: true,
    })),
  )
  expect(input.internalExecutorConfigBugsRemainFatal).toBe(true)
}

describe("openai-compatible provider", () => {
  test("streams text, assembles one tool call, and forwards the abort signal", async () => {
    const signal = new AbortController().signal
    let receivedBody: unknown
    let receivedOptions: unknown
    const streamChunks = [
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.5",
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              role: "assistant",
              content: "Inspecting ",
            },
          },
        ],
      },
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.5",
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"RE',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.5",
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              content: "README.md",
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: 'ADME.md"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.5",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            delta: {},
          },
        ],
      },
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.5",
        choices: [],
        usage: {
          prompt_tokens: 14,
          completion_tokens: 6,
          total_tokens: 20,
        } as unknown as OpenAI.CompletionUsage,
      } as OpenAI.Chat.ChatCompletionChunk,
    ] satisfies OpenAI.Chat.ChatCompletionChunk[]

    const provider = createProvider({
      model: "kimi-k2.5",
      client: createMockOpenAICompatibleClient(async (body, options) => {
        receivedBody = body
        receivedOptions = options

        return (async function* () {
          for (const chunk of streamChunks) {
            yield chunk
          }
        })()
      }),
    })

    const events = []
    for await (const event of provider.streamTurn({
      system: "system",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "inspect README.md" }],
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read a file",
          inputSchema: z.object({
            path: z.string(),
          }),
        },
      ],
      signal,
    })) {
      events.push(event)
    }

    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [{ role: "system", content: "system" }, { role: "user", content: "inspect README.md" }],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      parallel_tool_calls: true,
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
        },
      ],
    })
    expect(receivedOptions).toEqual({ signal })
    expect(events).toEqual([
      { type: "text.delta", text: "Inspecting " },
      { type: "text.delta", text: "README.md" },
      {
        type: "tool.call",
        callId: "call_1",
        name: "read",
        inputText: '{"path":"README.md"}',
      },
      {
        type: "usage",
        source: "provider",
        inputTokens: 14,
        outputTokens: 6,
      },
    ])
  })

  test("emits streamed reasoning deltas from reasoning_content chunks", async () => {
    const provider = createProvider({
      model: "kimi-k2.5",
      client: createMockOpenAICompatibleClient(async () => {
        return (async function* () {
          yield createOpenAICompatibleChunk({
            reasoning_content: "Need to inspect the README before calling read.",
          })
        })()
      }),
    })

    const events = []
    for await (const event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: "reasoning.delta",
        text: "Need to inspect the README before calling read.",
      },
    ])
  })

  test("emits streamed reasoning deltas from cumulative reasoning_details chunks", async () => {
    const provider = createProvider({
      model: "MiniMax-M2.7",
      client: createMockOpenAICompatibleClient(async () => {
        return (async function* () {
          yield createOpenAICompatibleChunk({
            reasoning_details: [{ text: "Need to inspect" }],
          })
          yield createOpenAICompatibleChunk({
            reasoning_details: [{ text: "Need to inspect the README" }],
          })
          yield createOpenAICompatibleChunk({
            content: "Opening README.md",
          })
        })()
      }),
    })

    const events = []
    for await (const event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: "reasoning.delta",
        text: "Need to inspect",
      },
      {
        type: "reasoning.delta",
        text: " the README",
      },
      {
        type: "text.delta",
        text: "Opening README.md",
      },
    ])
  })

  test("normalizes missing provider usage token counts", async () => {
    const provider = createProvider({
      model: "minimax-m2.7",
      client: createMockOpenAICompatibleClient(async () => {
        return (async function* () {
          yield {
            id: "chatcmpl_usage_fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "minimax-m2.7",
            choices: [],
            usage: {
              prompt_tokens: undefined,
              completion_tokens: undefined,
              total_tokens: 20,
            } as unknown as OpenAI.CompletionUsage,
          } as OpenAI.Chat.ChatCompletionChunk
        })()
      }),
    })

    const events = []
    for await (const event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: "usage",
        source: "provider",
        inputTokens: 0,
        outputTokens: 0,
      },
    ])
  })

  test("emits each streamed tool call exactly once when multiple tool calls are present", async () => {
    const provider = createProvider({
      model: "kimi-k2.5",
      client: createMockOpenAICompatibleClient(async () => {
        return (async function* () {
          yield {
            id: "chatcmpl_2",
            object: "chat.completion.chunk",
            created: 1,
            model: "kimi-k2.5",
            choices: [
              {
                index: 0,
                finish_reason: null,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "read",
                        arguments: '{"path":"README',
                      },
                    },
                    {
                      index: 1,
                      id: "call_2",
                      type: "function",
                      function: {
                        name: "search",
                        arguments: '{"query":"fix',
                      },
                    },
                  ],
                },
              },
            ],
          } satisfies OpenAI.Chat.ChatCompletionChunk

          yield {
            id: "chatcmpl_2",
            object: "chat.completion.chunk",
            created: 1,
            model: "kimi-k2.5",
            choices: [
              {
                index: 0,
                finish_reason: null,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: '.md"}',
                      },
                    },
                    {
                      index: 1,
                      function: {
                        arguments: 'bug"}',
                      },
                    },
                  ],
                },
              },
            ],
          } satisfies OpenAI.Chat.ChatCompletionChunk

          yield {
            id: "chatcmpl_2",
            object: "chat.completion.chunk",
            created: 1,
            model: "kimi-k2.5",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                delta: {},
              },
            ],
          } satisfies OpenAI.Chat.ChatCompletionChunk
        })()
      }),
    })

    const events = []
    for await (const event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: "tool.call",
        callId: "call_1",
        name: "read",
        inputText: '{"path":"README.md"}',
      },
      {
        type: "tool.call",
        callId: "call_2",
        name: "search",
        inputText: '{"query":"fixbug"}',
      },
    ])
  })

  test("serializes structured tool transcript for follow-up turns", async () => {
    let receivedBody: unknown

    const provider = createProvider({
      model: "kimi-k2.5",
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    const events = []
    for await (const event of provider.streamTurn({
      system: "system",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "inspect README.md" }],
        },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "Opening README.md" },
            {
              type: "tool_call",
              callId: "call_1",
              toolName: "read",
              inputText: '{"path":"README.md"}',
            },
          ],
        },
        {
          role: "tool",
          parts: [
            {
              type: "tool_result",
              callId: "call_1",
              toolName: "read",
              output: "file contents",
            },
          ],
        },
      ],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([])
    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "inspect README.md" },
        {
          role: "assistant",
          content: "Opening README.md",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "file contents",
        },
      ],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      parallel_tool_calls: true,
      tools: [],
    })
  })

  test("replays assistant reasoning alongside tool calls for follow-up turns", async () => {
    let receivedBody: unknown

    const provider = createProvider({
      model: "kimi-k2.5",
      requestConfig: {
        replayedReasoningField: "reasoning_content",
      },
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    for await (const _event of provider.streamTurn({
      system: "system",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "inspect README.md" }],
        },
        {
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              text: "Need to inspect the README before calling read.",
            },
            {
              type: "tool_call",
              callId: "call_1",
              toolName: "read",
              inputText: '{"path":"README.md"}',
            },
          ],
        },
      ],
      tools: [],
      signal: new AbortController().signal,
      thinking: {
        enabled: true,
      },
    })) {
      void _event
    }

    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "inspect README.md" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "Need to inspect the README before calling read.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
      ],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      parallel_tool_calls: true,
      tools: [],
    })
  })

  test("replays DeepSeek-compatible assistant tool calls with non-empty reasoning_content", async () => {
    let receivedBody: unknown
    const fixture = createDeepSeekToolReplayFixture()
    assertOpenAICompatibleToolReplayFixtureRequiresReasoning(fixture)

    const provider = createProvider({
      model: fixture.model,
      requestConfig: {
        replayedReasoningField: fixture.requiredReasoningField,
      },
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    for await (const _event of provider.streamTurn({
      system: "system",
      messages: fixture.messages,
      tools: [],
      signal: new AbortController().signal,
      thinking: {
        enabled: true,
      },
    })) {
      void _event
    }

    expect(receivedBody).toEqual({
      model: "deepseek-reasoner",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "inspect README.md" },
        {
          role: "assistant",
          content: null,
          reasoning_content: fixture.reasoningText,
          tool_calls: [
            {
              id: "call_deepseek_read",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
      ],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      parallel_tool_calls: true,
      tools: [],
    })
  })

  test("documents Doubao model-emitted unknown tool names as recoverable protocol fixture", () => {
    const fixture = createDoubaoUnknownToolCallFixture()

    assertDoubaoUnknownToolFixture(fixture)

    expect(fixture.modelEmittedToolCalls.map((call) => call.name)).toEqual(["shell_cmd", "list"])
    expect(fixture.availableToolNames).toEqual(["read", "grep", "glob"])
    expect(fixture.expectedToolResultErrors).toEqual([
      {
        callId: "call_doubao_shell_cmd",
        toolName: "shell_cmd",
        output: "Unknown tool: shell_cmd",
        isError: true,
      },
      {
        callId: "call_doubao_list",
        toolName: "list",
        output: "Unknown tool: list",
        isError: true,
      },
    ])
    expect(fixture.scope).toBe("model-emitted")
    expect(fixture.internalExecutorConfigBugsRemainFatal).toBe(true)
  })

  test("omits replayed provider-specific reasoning fields for unknown models by default", async () => {
    let receivedBody: unknown

    const provider = createProvider({
      model: "unknown-model",
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    for await (const _event of provider.streamTurn({
      system: "system",
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              text: "Need to inspect the README before calling read.",
            },
            {
              type: "tool_call",
              callId: "call_1",
              toolName: "read",
              inputText: '{"path":"README.md"}',
            },
          ],
        },
      ],
      tools: [],
      signal: new AbortController().signal,
      thinking: {
        enabled: true,
      },
    })) {
      void _event
    }

    expect(receivedBody).toEqual({
      model: "unknown-model",
      messages: [
        { role: "system", content: "system" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
      ],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      parallel_tool_calls: true,
      tools: [],
    })
  })

  test("forces internal kimi thinking preservation and omits reasoning_effort for default", async () => {
    let receivedBody: unknown

    const provider = createProvider({
      model: "kimi-k2.6",
      requestConfig: {
        replayedReasoningField: "reasoning_content",
        serializeThinking: true,
        forcePreserveReasoning: true,
        serializeReasoningEffort: true,
      },
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    for await (const _event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      thinking: {
        enabled: true,
        effort: "default",
      },
    })) {
      void _event
    }

    expect(receivedBody).toEqual({
      model: "kimi-k2.6",
      messages: [{ role: "system", content: "system" }],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      thinking: {
        type: "enabled",
        keep: "all",
      },
      parallel_tool_calls: true,
      tools: [],
    })
  })

  test("serializes MiniMax reasoning_split and replays reasoning_details", async () => {
    let receivedBody: unknown

    const provider = createProvider({
      model: "MiniMax-M2.7",
      requestConfig: {
        replayedReasoningField: "reasoning_details",
        reasoningSplit: true,
      },
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    for await (const _event of provider.streamTurn({
      system: "system",
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              text: "Need to call the tool before answering.",
            },
            {
              type: "tool_call",
              callId: "call_1",
              toolName: "read",
              inputText: '{"path":"README.md"}',
            },
          ],
        },
      ],
      tools: [],
      signal: new AbortController().signal,
      thinking: {
        enabled: true,
      },
    })) {
      void _event
    }

    expect(receivedBody).toEqual({
      model: "MiniMax-M2.7",
      messages: [
        { role: "system", content: "system" },
        {
          role: "assistant",
          content: null,
          reasoning_details: [{ text: "Need to call the tool before answering." }],
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
      ],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      reasoning_split: true,
      parallel_tool_calls: true,
      tools: [],
    })
  })

  test("normalizes disabled Kimi thinking requests to temperature 0.6", async () => {
    let receivedBody: unknown

    const provider = createProvider({
      model: "kimi-k2.6",
      requestConfig: {
        serializeThinking: true,
        disabledThinkingTemperature: 0.6,
      },
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    for await (const _event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      temperature: 1,
      thinking: {
        enabled: false,
      },
    })) {
      void _event
    }

    expect(receivedBody).toEqual({
      model: "kimi-k2.6",
      messages: [{ role: "system", content: "system" }],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      temperature: 0.6,
      thinking: {
        type: "disabled",
      },
      parallel_tool_calls: true,
      tools: [],
    })
  })

  for (const effort of ["low", "medium", "high"] as const) {
    test(`serializes explicit reasoning_effort=${effort} when supported`, async () => {
      let receivedBody: unknown

      const provider = createProvider({
        model: "kimi-k2.6",
        requestConfig: {
          replayedReasoningField: "reasoning_content",
          serializeThinking: true,
          forcePreserveReasoning: true,
          serializeReasoningEffort: true,
        },
        client: createMockOpenAICompatibleClient(async (body) => {
          receivedBody = body
          return (async function* () {})()
        }),
      })

      for await (const _event of provider.streamTurn({
        system: "system",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        thinking: {
          enabled: true,
          effort,
        },
      })) {
        void _event
      }

      expect(receivedBody).toEqual({
        model: "kimi-k2.6",
        messages: [{ role: "system", content: "system" }],
        stream: true,
        stream_options: {
          include_usage: true,
        },
        max_completion_tokens: 16000,
        thinking: {
          type: "enabled",
          keep: "all",
        },
        reasoning_effort: effort,
        parallel_tool_calls: true,
        tools: [],
      })
    })
  }

  test("fails fast when a tool schema cannot be converted to chat-completions JSON schema", async () => {
    const provider = createProvider({
      model: "kimi-k2.5",
      client: createMockOpenAICompatibleClient(async () => {
        throw new Error("should not reach client.create for unsupported schemas")
      }),
    })

    await expect(
      (async () => {
        for await (const _event of provider.streamTurn({
          system: "system",
          messages: [],
          tools: [
            {
              name: "union_tool",
              description: "Unsupported schema shape",
              inputSchema: z.union([z.string(), z.number()]),
            },
          ],
          signal: new AbortController().signal,
        })) {
          void _event
        }
      })(),
    ).rejects.toThrow("Unsupported Zod schema type for openai-compatible tools: ZodUnion")
  })

  test("serializes record-valued tool properties into chat-completions JSON schema", async () => {
    let receivedBody: unknown

    const provider = createProvider({
      model: "kimi-k2.5",
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    for await (const _event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [
        {
          name: "create_skill",
          description: "Create a skill with free-form frontmatter metadata",
          inputSchema: z.object({
            metadata: z.record(z.string()).optional().describe("Flat string metadata"),
            frontmatter: z.record(z.unknown()).describe("Free-form frontmatter values"),
          }),
        },
      ],
      signal: new AbortController().signal,
    })) {
      void _event
    }

    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [{ role: "system", content: "system" }],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      parallel_tool_calls: true,
      tools: [
        {
          type: "function",
          function: {
            name: "create_skill",
            description: "Create a skill with free-form frontmatter metadata",
            parameters: {
              type: "object",
              properties: {
                metadata: {
                  type: "object",
                  additionalProperties: {
                    type: "string",
                  },
                  description: "Flat string metadata",
                },
                frontmatter: {
                  type: "object",
                  additionalProperties: true,
                  description: "Free-form frontmatter values",
                },
              },
              required: ["frontmatter"],
              additionalProperties: false,
            },
          },
        },
      ],
    })
  })

  test("serializes effect-wrapped tool schemas by unwrapping to the underlying object shape", async () => {
    let receivedBody: unknown

    const provider = createProvider({
      model: "kimi-k2.5",
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    const skillToolSchema = z.object({
      action: z.enum(["activate", "list"]).optional(),
      name: z.string().trim().min(1).optional(),
    }).superRefine((_value, _ctx) => {})

    for await (const _event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [
        {
          name: "skill",
          description: "List or activate a skill",
          inputSchema: skillToolSchema,
        },
      ],
      signal: new AbortController().signal,
    })) {
      void _event
    }

    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [{ role: "system", content: "system" }],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      parallel_tool_calls: true,
      tools: [
        {
          type: "function",
          function: {
            name: "skill",
            description: "List or activate a skill",
            parameters: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["activate", "list"],
                },
                name: {
                  type: "string",
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
        },
      ],
    })
  })

  test("serializes anchor-only edit tool parameters and omits legacy edit fields", async () => {
    let receivedBody: unknown

    const provider = createProvider({
      model: "kimi-k2.5",
      client: createMockOpenAICompatibleClient(async (body) => {
        receivedBody = body
        return (async function* () {})()
      }),
    })

    const editTool = createEditTool({
      requestPermission: async () => ({
        requestId: "permission_auto",
        decision: "allow",
      }),
    })

    for await (const _event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [
        {
          name: editTool.name,
          description: editTool.description,
          inputSchema: editTool.inputSchema!,
        },
      ],
      signal: new AbortController().signal,
    })) {
      void _event
    }

    const parameters = (receivedBody as {
      tools: Array<{
        function: {
          parameters: {
            properties: Record<string, unknown>
            required: string[]
          }
        }
      }>
    }).tools[0]?.function.parameters

    expect(parameters).toEqual({
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative path to the existing file you want to modify, such as `src/app/main.ts`. The file must exist and be under 500 KB.",
        },
        operation: {
          type: "string",
          enum: ["replace", "prepend", "append"],
          description:
            "Edit operation to apply at the anchored location. Use `replace` to replace the inclusive span from `start` through `end` (or only `start` when `end` is omitted), `prepend` to insert `content` before the `start` anchor line, or `append` to insert `content` after `end` when `end` is provided, otherwise after `start`.",
        },
        start: {
          type: "string",
          description:
            "Anchor string copied from read output for the first targeted line. Reuse the exact anchor beginning with `L{line}#{hash}` from the latest read output.",
        },
        end: {
          type: "string",
          description:
            "Optional anchor string copied from read output for the last targeted line. Use it for a multi-line `replace` span or when `append` should insert after a later line than `start`. Do not pass `end` for `prepend`. Reuse the exact anchor beginning with `L{line}#{hash}` from the latest read output.",
        },
        content: {
          type: "string",
          description:
            "Content to insert exactly as written. Preserve indentation, spacing, and newlines exactly, and do not include read-output line numbers or anchor prefixes inside `content`.",
        },
      },
      required: ["path", "operation", "start", "content"],
      additionalProperties: false,
      description:
        "Modify an existing workspace file using line anchors copied from read output. Read the file first, then copy the relevant anchor strings that begin with `L{line}#{hash}` into `start` and optional `end`. Use `replace` to replace the inclusive anchored range from `start` through `end` (or just `start` when `end` is omitted), `prepend` to insert `content` before the `start` anchor line, or `append` to insert `content` after `end` when `end` is provided, otherwise after `start`. This tool requires permission. Files larger than 500 KB are rejected. Paths must stay inside the workspace. Preserve inserted content exactly as written.",
    })

    expect(parameters.properties).not.toHaveProperty("oldText")
    expect(parameters.properties).not.toHaveProperty("newText")
    expect(parameters.properties).not.toHaveProperty("replaceAll")
  })
})
