import { describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { z } from "zod"
import { createOpenAICompatibleProvider } from "../../src/model"

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

    const provider = createOpenAICompatibleProvider({
      model: "kimi-k2.5",
      client: {
        chat: {
          completions: {
            async create(body, options) {
              receivedBody = body
              receivedOptions = options

              return (async function* () {
                for (const chunk of streamChunks) {
                  yield chunk
                }
              })()
            },
          },
        },
      },
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

  test("emits each streamed tool call exactly once when multiple tool calls are present", async () => {
    const provider = createOpenAICompatibleProvider({
      model: "kimi-k2.5",
      client: {
        chat: {
          completions: {
            async create() {
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
            },
          },
        },
      },
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

    const provider = createOpenAICompatibleProvider({
      model: "kimi-k2.5",
      client: {
        chat: {
          completions: {
            async create(body) {
              receivedBody = body
              return (async function* () {})()
            },
          },
        },
      },
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
      tools: [],
    })
  })

  test("fails fast when a tool schema cannot be converted to chat-completions JSON schema", async () => {
    const provider = createOpenAICompatibleProvider({
      model: "kimi-k2.5",
      client: {
        chat: {
          completions: {
            async create() {
              throw new Error("should not reach client.create for unsupported schemas")
            },
          },
        },
      },
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
})
