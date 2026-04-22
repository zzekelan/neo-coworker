import { describe, expect, test } from "bun:test"

import {
  FailoverReason,
  createModelProvider,
  createModelRuntimeApi,
  type ModelObserverEvent,
} from "../../src/model"

describe("model error telemetry", () => {
  test("emits error.classified when the provider runtime throws", async () => {
    const observedEvents: ModelObserverEvent[] = []
    const provider = createModelProvider({
      runtime: createModelRuntimeApi({
        streamTurn() {
          const error = new Error("Too many requests, retry after 2 seconds")
          ;(error as Error & { status?: number }).status = 429
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  return Promise.reject(error)
                },
              }
            },
          }
        },
      }),
      observer: {
        recordModelEvent(event) {
          observedEvents.push(event)
        },
      },
    })

    let thrownError: unknown = null

    try {
      for await (const _event of provider.streamTurn({
        systemPrompt: "System prompt",
        skillCatalog: [],
        activeSkills: [],
        tools: [],
        transcript: [],
        signal: new AbortController().signal,
        sessionId: "session_1",
        runId: "run_1",
        turnKey: "run_1:turn_1",
      })) {}
    } catch (error) {
      thrownError = error
    }

    expect(thrownError).toBeInstanceOf(Error)
    expect((thrownError as Error).message).toContain("Too many requests")
    expect(observedEvents).toContainEqual(expect.objectContaining({
      type: "error.classified",
      sessionId: "session_1",
      runId: "run_1",
      turnKey: "run_1:turn_1",
      errorType: FailoverReason.rate_limit,
      severity: "warning",
      shouldRetry: true,
      shouldRotateCredential: true,
      shouldFallback: true,
    }))
  })

  test("estimates non-zero output usage when only reasoning deltas are streamed", async () => {
    const provider = createModelProvider({
      runtime: createModelRuntimeApi({
        async *streamTurn() {
          yield {
            type: "reasoning.delta" as const,
            text: "Need to inspect the persisted transcript before answering.",
          }
        },
      }),
    })

    const events = []
    for await (const event of provider.streamTurn({
      systemPrompt: "System prompt",
      skillCatalog: [],
      activeSkills: [],
      tools: [],
      transcript: [],
      signal: new AbortController().signal,
      sessionId: "session_reasoning_usage",
      runId: "run_reasoning_usage",
      turnKey: "run_reasoning_usage:turn_1",
    })) {
      events.push(event)
    }

    expect(events).toEqual(expect.arrayContaining([
      {
        type: "reasoning.delta",
        text: "Need to inspect the persisted transcript before answering.",
      },
    ]))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "usage",
        source: "estimated",
        outputTokens: expect.any(Number),
      }),
    ]))
    const usageEvent = events.find((event) => event && typeof event === "object" && "type" in event && event.type === "usage")
    expect((usageEvent as { outputTokens: number }).outputTokens).toBeGreaterThan(0)
    expect((usageEvent as { inputTokens: number; outputTokens: number }).outputTokens).toBeGreaterThanOrEqual(
      (usageEvent as { inputTokens: number; outputTokens: number }).inputTokens / 10,
    )
  })
})
