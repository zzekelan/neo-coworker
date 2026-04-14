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
})
