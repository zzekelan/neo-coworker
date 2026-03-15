import { describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { buildCli } from "../src/main"

describe("provider selection", () => {
  test("buildCli wires LLM_PROVIDER=openai through the responses adapter", async () => {
    const openAIConfigs: unknown[] = []
    const runCliCalls: unknown[] = []
    let receivedBody: unknown
    let receivedOptions: unknown
    const fakeClient = {
      responses: {
        stream(body: unknown, options: unknown) {
          receivedBody = body
          receivedOptions = options
          return (async function* () {})()
        },
      },
    } as unknown as OpenAI

    await buildCli({
      env: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gpt-5",
      },
      createClient(config) {
        openAIConfigs.push(config)
        return fakeClient
      },
      createIo() {
        return { write() {}, prompt: async () => "y", onSigint() {} }
      },
      async runCliImpl(input) {
        runCliCalls.push(input)
      },
    }).run(["run", "hello provider"])

    expect(openAIConfigs).toEqual([{ apiKey: "test-key", baseURL: undefined, timeout: undefined }])

    const provider = (runCliCalls[0] as { provider: { streamTurn: Function } }).provider
    const events = []
    for await (const event of provider.streamTurn({
      systemPrompt: "system",
      activeSkillInstructions: [],
      tools: [],
      transcript: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([])
    expect(receivedBody).toEqual({
      model: "gpt-5",
      input: [],
      instructions: "system\n\nAvailable tools:",
      tools: [],
    })
    expect(receivedOptions).toEqual({ signal: expect.any(AbortSignal) })
  })

  test("buildCli wires LLM_PROVIDER=openai-compatible through the compatible adapter", async () => {
    const openAIConfigs: unknown[] = []
    const runCliCalls: unknown[] = []
    let receivedBody: unknown
    let receivedOptions: unknown
    const fakeClient = {
      chat: {
        completions: {
          create(body: unknown, options: unknown) {
            receivedBody = body
            receivedOptions = options
            return (async function* () {})()
          },
        },
      },
    } as unknown as OpenAI

    await buildCli({
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "kimi-k2.5",
        LLM_BASE_URL: "https://coding.example.com/v1",
      },
      createClient(config) {
        openAIConfigs.push(config)
        return fakeClient
      },
      createIo() {
        return { write() {}, prompt: async () => "y", onSigint() {} }
      },
      async runCliImpl(input) {
        runCliCalls.push(input)
      },
    }).run(["run", "hello provider"])

    expect(openAIConfigs).toEqual([
      {
        apiKey: "test-key",
        baseURL: "https://coding.example.com/v1",
        timeout: undefined,
      },
    ])

    const provider = (runCliCalls[0] as { provider: { streamTurn: Function } }).provider
    const events = []
    for await (const event of provider.streamTurn({
      systemPrompt: "system",
      activeSkillInstructions: [],
      tools: [],
      transcript: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([])
    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [{ role: "system", content: "system\n\nAvailable tools:" }],
      stream: true,
      tools: [],
    })
    expect(receivedOptions).toEqual({ signal: expect.any(AbortSignal) })
  })
})
