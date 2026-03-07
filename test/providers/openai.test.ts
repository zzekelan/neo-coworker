import { describe, expect, test } from "bun:test"
import { createOpenAIProvider } from "../../src/providers/openai"

describe("openai provider", () => {
  test("normalizes streamed text and tool calls", async () => {
    const provider = createOpenAIProvider({
      model: "gpt-5",
      client: {
        responses: {
          stream: async function* () {
            yield { type: "response.output_text.delta", delta: "Hello" }
            yield {
              type: "response.function_call_arguments.delta",
              item_id: "call_1",
              name: "read",
              delta: "{\"path\":\"README.md\"}",
            }
            yield { type: "response.completed" }
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

    expect(events).toContainEqual({ type: "text.delta", text: "Hello" })
    expect(events).toContainEqual({
      type: "tool.call",
      callId: "call_1",
      name: "read",
      inputText: "{\"path\":\"README.md\"}",
    })
  })
})
