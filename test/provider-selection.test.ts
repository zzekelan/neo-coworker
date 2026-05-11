import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type OpenAI from "openai"
import { buildCli, type RunCliInput } from "../src/cli"
import {
  createStandaloneServerComposition,
  createSessionRunService,
  getDefaultCliStoragePath,
  openSessionDatabase,
} from "../src/bootstrap"
import {
  SYSTEM_REMINDER_NOTICE,
  createModelProvider,
  createModelRuntimeApi,
} from "../src/model"
import { createObservabilityRepository } from "../src/observability"

type ProviderRunCliInput = RunCliInput & {
  provider: NonNullable<RunCliInput["provider"]>
  createLocalStorageImpl: NonNullable<RunCliInput["createLocalStorageImpl"]>
  createLocalRuntimeImpl: NonNullable<RunCliInput["createLocalRuntimeImpl"]>
}

function assertProviderRunCliInput(input: RunCliInput): asserts input is ProviderRunCliInput {
  if (!input.provider || !input.createLocalStorageImpl || !input.createLocalRuntimeImpl) {
    throw new Error("Expected buildCli() to provide the local provider branch")
  }
}

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
      timeline: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "usage",
        source: "estimated",
        outputTokens: 0,
        inputTokens: expect.any(Number),
      }),
    ])
    expect(receivedBody).toEqual({
      model: "gpt-5",
      input: [],
      instructions: ["system", SYSTEM_REMINDER_NOTICE].join("\n\n"),
      parallel_tool_calls: true,
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
      timeline: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "usage",
        source: "estimated",
        outputTokens: 0,
        inputTokens: expect.any(Number),
      }),
    ])
    expect(receivedBody).toEqual({
      model: "kimi-k2.5",
      messages: [
        {
          role: "system",
          content: ["system", SYSTEM_REMINDER_NOTICE].join("\n\n"),
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
          assertProviderRunCliInput(input)
          const localStorage = await input.createLocalStorageImpl(workspaceRoot)

          try {
            for await (const _event of input.provider.streamTurn({
              systemPrompt: "system",
              skillCatalog: [],
              activeSkills: [],
              tools: [],
              timeline: [],
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
        ).toEqual(["model.turn.requested", "model.prompt.assembled", "model.turn.usage"])
      } finally {
        database.close(false)
      }
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  })

  test("local CLI and standalone app-server resolve the same effective thinking config", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "provider-thinking-parity-workspace-"))
    const serverRoot = await mkdtemp(join(tmpdir(), "provider-thinking-parity-server-"))
    const env = {
      LLM_PROVIDER: "openai-compatible",
      LLM_API_KEY: "test-key",
      LLM_MODEL: "kimi-k2.6",
      LLM_BASE_URL: "https://api.moonshot.ai/v1",
      LLM_THINKING_ENABLED: "true",
      LLM_REASONING_EFFORT: "high",
    }
    const cliThinking: unknown[] = []
    const serverThinking: unknown[] = []

    try {
      await buildCli({
        env,
        createIo() {
          return { write() {}, prompt: async () => "y", onSigint() {} }
        },
        createOpenAICompatibleProviderImpl(input) {
          return createModelProvider({
            observer: input.observer,
            runtime: createModelRuntimeApi({
              async *streamTurn(request) {
                cliThinking.push(request.thinking)
              },
            }),
          })
        },
        async runCliImpl(input) {
          assertProviderRunCliInput(input)
          const localStorage = await input.createLocalStorageImpl(workspaceRoot)

          try {
            const service = createSessionRunService({
              repository: localStorage.repository,
              now: Date.now,
            })
            const session = localStorage.repository.sessions.create({
              id: "session_cli_reasoning_config",
              directory: workspaceRoot,
              workspaceRoot,
              createdAt: Date.now(),
            })
            const started = service.startRun({
              sessionId: session.id,
              runId: "run_cli_reasoning_config",
              messageId: "message_cli_reasoning_config",
            })
            localStorage.repository.parts.create({
              sessionId: session.id,
              runId: started.run.id,
              messageId: started.message.id,
              kind: "text",
              sequence: 0,
              text: "Confirm CLI thinking parity.",
            })

            const runtime = input.createLocalRuntimeImpl({
              provider: input.provider,
              repository: localStorage.repository,
              permissionRepository: localStorage.permissionRepository,
              now: Date.now,
            })
            const handle = await runtime.run({
              sessionId: session.id,
              runId: started.run.id,
            })

            for await (const _event of handle.events) {
              // Drain runtime events.
            }
          } finally {
            await localStorage.closeImpl()
          }
        },
      }).run(["run", "hello provider"])

      const composition = await createStandaloneServerComposition({
        cwd: serverRoot,
        env: {
          ...env,
          NCOWORKER_SERVER_DB_PATH: join(serverRoot, "server.sqlite"),
        },
        resolveContextWindowSizeImpl: async () => ({
          contextWindow: 65_536,
          source: "provider",
        }),
        resolveProviderCapabilitiesImpl: async () => ({
          provider: "openai-compatible",
          providerId: "moonshotai",
          model: "kimi-k2.6",
          catalog: {
            source: "models.dev",
            miss: false,
          },
          reasoning: {
            supported: true,
            source: "models.dev",
          },
          toolCall: {
            supported: true,
            source: "models.dev",
          },
          interleaved: {
            supported: true,
            field: "reasoning_content",
            source: "models.dev",
          },
          reasoningEffort: {
            supported: true,
            source: "models.dev",
          },
          thinkingControls: {
            thinking: {
              supported: true,
              source: "override",
            },
            reasoningEffort: {
              supported: true,
              source: "override",
            },
          },
        }),
        createDefaultProviderImpl: async (providerInput = {}) =>
          createModelProvider({
            observer: providerInput.modelObserver,
            replayGuard: providerInput.replayGuard,
            runtime: createModelRuntimeApi({
              async *streamTurn(request) {
                serverThinking.push(request.thinking)
              },
            }),
          }),
      })

      try {
        const service = createSessionRunService({
          repository: composition.repository,
          now: Date.now,
        })
        const session = composition.repository.sessions.create({
          id: "session_server_reasoning_config",
          directory: workspaceRoot,
          workspaceRoot,
          createdAt: Date.now(),
        })
        const started = service.startRun({
          sessionId: session.id,
          runId: "run_server_reasoning_config",
          messageId: "message_server_reasoning_config",
        })
        composition.repository.parts.create({
          sessionId: session.id,
          runId: started.run.id,
          messageId: started.message.id,
          kind: "text",
          sequence: 0,
          text: "Confirm server thinking parity.",
        })

        const runtime = composition.createRuntimeImpl({
          repository: composition.repository,
          permissionRepository: composition.permissionRepository,
          now: Date.now,
        })
        const handle = await runtime.run({
          sessionId: session.id,
          runId: started.run.id,
        })

        for await (const _event of handle.events) {
          // Drain runtime events.
        }
      } finally {
        composition.closeDatabase()
      }

      expect(cliThinking).toEqual([
        {
          enabled: true,
          effort: "high",
        },
      ])
      expect(serverThinking).toEqual(cliThinking)
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true })
      await rm(serverRoot, { force: true, recursive: true })
    }
  })
})
