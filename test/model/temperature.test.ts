import { describe, expect, test } from "bun:test"

import {
  createFakeAdapter,
  createOpenAIAdapter,
  createOpenAICompatibleAdapter,
  type ModelTurnRequest,
} from "../../src/model"

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _event of stream) {
    void _event
  }
}

describe("model adapter temperature threading", () => {
  test("openai adapter passes temperature when defined", async () => {
    let receivedBody: unknown

    const adapter = createOpenAIAdapter({
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

    await drain(adapter.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      temperature: 0.5,
    }))

    expect(receivedBody).toEqual({
      model: "gpt-5",
      input: [],
      instructions: "system",
      parallel_tool_calls: true,
      temperature: 0.5,
      tools: [],
    })
  })

  test("openai adapter omits temperature when undefined", async () => {
    let receivedBody: unknown

    const adapter = createOpenAIAdapter({
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

    await drain(adapter.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    }))

    expect(receivedBody).toEqual({
      model: "gpt-5",
      input: [],
      instructions: "system",
      parallel_tool_calls: true,
      tools: [],
    })
  })

  test("openai-compatible adapter passes temperature 0 when defined", async () => {
    let receivedBody: unknown

    const adapter = createOpenAICompatibleAdapter({
      model: "kimi-k2.5",
      client: {
        chat: {
          completions: {
            create(body) {
              receivedBody = body
              return (async function* () {})()
            },
          },
        },
      },
    })

    await drain(adapter.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      temperature: 0,
    }))

    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [{ role: "system", content: "system" }],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      temperature: 0,
      parallel_tool_calls: true,
      tools: [],
    })
  })

  test("openai-compatible adapter omits temperature when undefined", async () => {
    let receivedBody: unknown

    const adapter = createOpenAICompatibleAdapter({
      model: "kimi-k2.5",
      client: {
        chat: {
          completions: {
            create(body) {
              receivedBody = body
              return (async function* () {})()
            },
          },
        },
      },
    })

    await drain(adapter.streamTurn({
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    }))

    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [{ role: "system", content: "system" }],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_completion_tokens: 16000,
      parallel_tool_calls: true,
      tools: [],
    })
  })

  test("fake adapter still accepts requests with temperature", async () => {
    const request = {
      system: "system",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      temperature: 0.7,
    } satisfies ModelTurnRequest

    let capturedRequest: ModelTurnRequest | undefined

    const adapter = createFakeAdapter({
      onRequest(nextRequest) {
        capturedRequest = nextRequest
      },
    })

    await drain(adapter.streamTurn(request))

    expect(capturedRequest).toEqual(request)
  })
})
