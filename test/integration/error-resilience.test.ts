import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type OpenAI from "openai"

import { createRuntime, createDefaultProvider } from "../../src/bootstrap"
import {
  createModelProvider,
  createModelRuntimeApi,
} from "../../src/model"
import {
  createPermissionRepository,
} from "../../src/permission"
import {
  createSessionRepository,
  createSessionRunService,
  openSessionDatabase,
  type SessionRepository,
} from "../../src/session"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("integration: error resilience", () => {
  test("single API key remains backward compatible", async () => {
    const calls: Array<{ apiKey: string }> = []
    const provider = await createDefaultProvider({
      env: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "single-key",
        LLM_MODEL: "gpt-5",
      },
      retryAttempts: 4,
      createClient(config) {
        calls.push({ apiKey: config.apiKey })
        return {
          responses: {
            stream: async function* () {
              yield {
                type: "response.output_text.delta",
                delta: "Hello from single key.",
              }
              yield {
                type: "response.completed",
                response: {
                  usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                  },
                },
              }
            },
          },
        } as unknown as OpenAI
      },
    })

    const events = await collectEvents(
      provider.streamTurn({
        systemPrompt: "system",
        skillCatalog: [],
        activeSkills: [],
        tools: [],
        transcript: [],
        signal: new AbortController().signal,
      }),
    )

    expect(calls).toEqual([{ apiKey: "single-key" }])
    expect(events).toEqual([
      { type: "text.delta", text: "Hello from single key." },
      { type: "usage", source: "provider", inputTokens: 10, outputTokens: 5 },
    ])
  })

  test("multiple API keys rotate on 429-like failure", async () => {
    const calls: string[] = []
    const provider = await createDefaultProvider({
      env: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "key-a,key-b",
        LLM_MODEL: "gpt-5",
      },
      retryAttempts: 4,
      randomImpl: () => 0,
      sleepImpl: async () => {},
      createClient(config) {
        calls.push(config.apiKey)
        return {
          responses: {
            stream: async function* () {
              if (config.apiKey === "key-a") {
                const error = new Error("rate limit exceeded") as Error & {
                  status: number
                  headers: Record<string, string>
                }
                error.status = 429
                error.headers = {
                  "x-ratelimit-limit-requests": "100",
                  "x-ratelimit-remaining-requests": "0",
                  "x-ratelimit-reset-requests": "1s",
                }
                throw error
              }

              yield {
                type: "response.output_text.delta",
                delta: "Recovered with second key.",
              }
              yield {
                type: "response.completed",
                response: {
                  usage: {
                    input_tokens: 12,
                    output_tokens: 6,
                  },
                },
              }
            },
          },
        } as unknown as OpenAI
      },
    })

    const events = await collectEvents(
      provider.streamTurn({
        systemPrompt: "system",
        skillCatalog: [],
        activeSkills: [],
        tools: [],
        transcript: [],
        signal: new AbortController().signal,
        sessionId: "session_rotation",
        runId: "run_rotation",
        turnKey: "run_rotation:turn_1",
      }),
    )

    expect(calls).toEqual(["key-a", "key-b"])
    expect(events.at(0)).toEqual({ type: "text.delta", text: "Recovered with second key." })
  })

  test("retryable classified provider failure is retried and eventually succeeds", async () => {
    const harness = await createHarness("error-resilience-retry")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_error_resilience_retry",
      messageId: "message_error_resilience_retry",
      prompt: "Retry a retryable provider failure",
    })
    let attempts = 0
    const runtime = createRuntime({
      provider: createModelProvider({
        runtime: createModelRuntimeApi({
          async *streamTurn() {
            attempts += 1
            if (attempts === 1) {
              const error = new Error("timeout") as Error & {
                classified?: {
                  reason: string
                  original: Error
                  retryable: boolean
                  shouldCompress: boolean
                  shouldRotateCredential: boolean
                  shouldFallback: boolean
                }
              }
              error.classified = {
                reason: "timeout",
                original: error,
                retryable: true,
                shouldCompress: false,
                shouldRotateCredential: false,
                shouldFallback: false,
              }
              throw error
            }

            yield {
              type: "text.delta",
              text: "Recovered after classified retry.",
            }
          },
        }),
      }),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)

    expect(attempts).toBe(2)
    expect(events.filter((event) => isRetryEvent(event))).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      runId: started.run.id,
    })
  })
})

async function createHarness(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(root)
  const workspaceRoot = join(root, "workspace")
  const databasePath = join(root, "session.sqlite")
  const now = createMonotonicClock()
  const database = trackDatabase(openSessionDatabase(databasePath))
  const repository = createSessionRepository({
    database,
    now,
  })
  const permissionRepository = createPermissionRepository({
    database,
    now,
  })
  const service = createSessionRunService({
    repository,
    now,
  })
  const session = repository.sessions.create({
    id: `${prefix}_session`,
    directory: workspaceRoot,
    workspaceRoot,
    createdAt: now(),
  })

  return {
    repository,
    permissionRepository,
    service,
    session,
    now,
  }
}

function startPromptRun(input: {
  repository: SessionRepository
  service: ReturnType<typeof createSessionRunService>
  sessionId: string
  runId: string
  messageId: string
  prompt: string
}) {
  const started = input.service.startRun({
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: input.messageId,
  })

  input.repository.parts.create({
    sessionId: input.sessionId,
    runId: started.run.id,
    messageId: started.message.id,
    kind: "text",
    sequence: 0,
    text: input.prompt,
  })

  return started
}

async function collectEvents(events: AsyncIterable<unknown>) {
  const collected: unknown[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

function isRetryEvent(event: unknown): event is { type: "model.turn.retrying" } {
  return !!event && typeof event === "object" && "type" in event && event.type === "model.turn.retrying"
}

function createMonotonicClock(start = 1) {
  let current = start
  return () => {
    const value = current
    current += 1
    return value
  }
}

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}
