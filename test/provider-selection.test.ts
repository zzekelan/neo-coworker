import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type OpenAI from "openai"
import { buildCli } from "../src/cli"
import { getDefaultCliStoragePath, openSessionDatabase } from "../src/bootstrap"
import {
  createModelProvider,
  createModelRuntimeApi,
} from "../src/model"
import { createObservabilityRepository } from "../src/observability"

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
      skillCatalog: [],
      activeSkills: [],
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
      instructions: [
        "system",
        "Skill catalog:\n- None.",
        "Active skill instructions:\n- None.",
      ].join("\n\n"),
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
      skillCatalog: [],
      activeSkills: [],
      tools: [],
      transcript: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([])
    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [
        {
          role: "system",
          content: [
            "system",
            "Skill catalog:\n- None.",
            "Active skill instructions:\n- None.",
          ].join("\n\n"),
        },
      ],
      stream: true,
      tools: [],
    })
    expect(receivedOptions).toEqual({ signal: expect.any(AbortSignal) })
  })

  test("buildCli records local default-provider model events after local storage opens", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "provider-observability-"))

    try {
      await buildCli({
        env: {
          LLM_PROVIDER: "openai",
          LLM_API_KEY: "test-key",
          LLM_MODEL: "gpt-5",
        },
        createClient() {
          return {} as OpenAI
        },
        createOpenAIProviderImpl(input) {
          return createModelProvider({
            observer: input.observer,
            runtime: createModelRuntimeApi({
              async *streamTurn() {},
            }),
          })
        },
        createIo() {
          return { write() {}, prompt: async () => "y", onSigint() {} }
        },
        async runCliImpl(input) {
          const localStorage = await input.createLocalStorageImpl(workspaceRoot)

          try {
            for await (const _event of input.provider.streamTurn({
              systemPrompt: "system",
              skillCatalog: [],
              activeSkills: [],
              tools: [],
              transcript: [],
              signal: new AbortController().signal,
              sessionId: "session_local_provider",
              runId: "run_local_provider",
            })) {
              // The custom provider emits no model events.
            }
          } finally {
            await localStorage.closeImpl()
          }
        },
      }).run(["run", "hello provider"])

      const database = openSessionDatabase(getDefaultCliStoragePath(workspaceRoot))

      try {
        const observabilityRepository = createObservabilityRepository({
          database,
          now: () => 100,
        })

        expect(
          observabilityRepository.runEvents
            .listByRun("run_local_provider")
            .map((event) => event.eventType),
        ).toEqual(["model.turn.requested", "model.prompt.assembled"])
      } finally {
        database.close(false)
      }
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  })
})
