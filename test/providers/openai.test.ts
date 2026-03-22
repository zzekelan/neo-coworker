import { describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { createOpenAIProvider } from "../../src/model"

describe("openai provider", () => {
  test("emits one complete tool call after multi-chunk arguments finish", async () => {
    const signal = new AbortController().signal
    let receivedBody: unknown
    let receivedOptions: unknown
    const streamEvents = [
      {
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
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 0,
        sequence_number: 1,
        delta: "{\"path\":",
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 0,
        sequence_number: 2,
        delta: "\"README.md\"}",
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        output_index: 0,
        sequence_number: 3,
        arguments: "{\"path\":\"README.md\"}",
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 1,
        content_index: 0,
        sequence_number: 4,
        delta: "Hello",
      },
    ] satisfies OpenAI.Responses.ResponseStreamEvent[]

    const provider = createOpenAIProvider({
      model: "gpt-5",
      client: {
        responses: {
          stream: async function* (body, options) {
            receivedBody = body
            receivedOptions = options

            for (const event of streamEvents) {
              yield event
            }
          },
        },
      },
    })

    const events = []
    for await (const event of provider.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal,
    })) {
      events.push(event)
    }

    expect(receivedBody).toEqual({
      model: "gpt-5",
      input: [],
      instructions: "system",
      tools: [],
    })
    expect(receivedOptions).toEqual({ signal })
    expect(events.filter((event) => event.type === "tool.call")).toEqual([
      {
        type: "tool.call",
        callId: "call_1",
        name: "read",
        inputText: "{\"path\":\"README.md\"}",
      },
    ])
    expect(events).toContainEqual({
      type: "tool.call",
      callId: "call_1",
      name: "read",
      inputText: "{\"path\":\"README.md\"}",
    })
    expect(events).toContainEqual({ type: "text.delta", text: "Hello" })
  })

  test("serializes structured tool transcript into responses input items", async () => {
    let receivedBody: unknown

    const provider = createOpenAIProvider({
      model: "gpt-5",
      client: {
        responses: {
          stream(body) {
            receivedBody = body
            return (async function* () {})()
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
      model: "gpt-5",
      input: [
        {
          role: "user",
          content: "inspect README.md",
          type: "message",
        },
        {
          role: "assistant",
          content: "Opening README.md",
          type: "message",
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read",
          arguments: '{"path":"README.md"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "file contents",
        },
      ],
      instructions: "system",
      tools: [],
    })
  })
})
