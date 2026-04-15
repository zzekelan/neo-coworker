import { describe, expect, test } from "bun:test"

import {
  FailoverReason,
  FallbackChain,
  classifyError,
} from "../../src/model"
import type {
  FallbackProvider,
  ModelProviderAdapter,
  ProviderFallbackTriggeredEvent,
} from "../../src/model"

type NamedAdapter = ModelProviderAdapter & {
  providerName: string
}

describe("FallbackChain", () => {
  test("orders providers by priority and uses the highest-priority provider first", async () => {
    const attempts: string[] = []
    const chain = new FallbackChain([
      createProvider("secondary", 20),
      createProvider("primary", 10),
    ])

    const result = await chain.execute(async (adapter) => {
      const providerName = readProviderName(adapter)
      attempts.push(providerName)
      return `${providerName}:ok`
    })

    expect(result).toBe("primary:ok")
    expect(attempts).toEqual(["primary"])
  })

  test("falls back to the next provider when the failure is classified for fallback", async () => {
    const attempts: string[] = []
    const chain = new FallbackChain([
      createProvider("primary", 10),
      createProvider("secondary", 20),
    ])

    const result = await chain.execute(async (adapter) => {
      const providerName = readProviderName(adapter)
      attempts.push(providerName)

      if (providerName === "primary") {
        throw classifyError(withStatus(new Error("Too many requests, retry after 2 seconds"), 429))
      }

      return `${providerName}:ok`
    })

    expect(result).toBe("secondary:ok")
    expect(attempts).toEqual(["primary", "secondary"])
  })

  test("emits provider.fallback_triggered telemetry with provider names and attempt number", async () => {
    const observedEvents: ProviderFallbackTriggeredEvent[] = []
    const chain = new FallbackChain(
      [
        createProvider("primary", 10),
        createProvider("secondary", 20),
      ],
      {
        observer: {
          recordModelEvent(event: unknown) {
            if (isProviderFallbackTriggeredEvent(event)) {
              observedEvents.push(event)
            }
          },
        },
        telemetry: {
          sessionId: "session_1",
          runId: "run_1",
          turnKey: "run_1:turn_1",
        },
      },
    )

    const result = await chain.execute(async (adapter) => {
      const providerName = readProviderName(adapter)

      if (providerName === "primary") {
        throw classifyError(withStatus(new Error("Too many requests"), 429))
      }

      return providerName
    })

    expect(result).toBe("secondary")
    expect(observedEvents).toEqual([
      {
        type: "provider.fallback_triggered",
        sessionId: "session_1",
        runId: "run_1",
        turnKey: "run_1:turn_1",
        fromProvider: "primary",
        toProvider: "secondary",
        errorType: FailoverReason.rate_limit,
        attemptNumber: 1,
      },
    ])
  })

  test("does not try the next provider when shouldFallback is false", async () => {
    const attempts: string[] = []
    const chain = new FallbackChain([
      createProvider("primary", 10),
      createProvider("secondary", 20),
    ])
    const failure = classifyError(withStatus(new Error("Service unavailable"), 503))

    let thrownError: unknown = null

    try {
      await chain.execute(async (adapter) => {
        const providerName = readProviderName(adapter)
        attempts.push(providerName)
        throw failure
      })
    } catch (error) {
      thrownError = error
    }

    expect(thrownError).toBe(failure.original)
    expect(attempts).toEqual(["primary"])
  })

  test("skips providers that are cooling down until the cooldown expires", async () => {
    const attempts: string[] = []
    const now = { value: 0 }
    let primaryCallCount = 0
    const chain = new FallbackChain(
      [
        createProvider("primary", 10),
        createProvider("secondary", 20),
      ],
      {
        cooldownMs: 1_000,
        now: () => new Date(now.value),
      },
    )

    const run = () => chain.execute(async (adapter) => {
      const providerName = readProviderName(adapter)
      attempts.push(providerName)

      if (providerName === "primary" && primaryCallCount === 0) {
        primaryCallCount += 1
        throw classifyError(withStatus(new Error("Rate limit"), 429))
      }

      if (providerName === "primary") {
        primaryCallCount += 1
      }

      return providerName
    })

    expect(await run()).toBe("secondary")
    expect(attempts).toEqual(["primary", "secondary"])

    attempts.length = 0
    expect(await run()).toBe("secondary")
    expect(attempts).toEqual(["secondary"])

    now.value = 1_001
    attempts.length = 0
    expect(await run()).toBe("primary")
    expect(attempts).toEqual(["primary"])
  })

  test("throws an aggregate error when every fallback provider fails", async () => {
    const chain = new FallbackChain([
      createProvider("primary", 10),
      createProvider("secondary", 20),
      createProvider("tertiary", 30),
    ])

    let thrownError: unknown = null

    try {
      await chain.execute(async (adapter) => {
        const providerName = readProviderName(adapter)
        throw classifyError(withStatus(new Error(`${providerName} rate limited`), 429))
      })
    } catch (error) {
      thrownError = error
    }

    expect(thrownError).toBeInstanceOf(AggregateError)
    expect((thrownError as AggregateError).message).toContain("No model provider succeeded")
    expect((thrownError as AggregateError).errors).toHaveLength(3)
  })

  test("can start fallback from an already-classified primary failure", async () => {
    const attempts: string[] = []
    const chain = new FallbackChain([
      createProvider("primary", 10),
      createProvider("secondary", 20),
    ])
    const initialFailure = classifyError(withStatus(new Error("Model not found"), 404))

    const result = await chain.execute(async (adapter) => {
      const providerName = readProviderName(adapter)
      attempts.push(providerName)
      return providerName
    }, initialFailure)

    expect(result).toBe("secondary")
    expect(attempts).toEqual(["secondary"])
  })
})

function createProvider(name: string, priority: number): FallbackProvider {
  return {
    name,
    priority,
    createAdapter: () => ({
      providerName: name,
      async *streamTurn() {},
    }) as NamedAdapter,
  }
}

function readProviderName(adapter: ModelProviderAdapter) {
  return (adapter as NamedAdapter).providerName
}

function withStatus(error: Error, status: number) {
  ;(error as Error & { status?: number }).status = status
  return error
}

function isProviderFallbackTriggeredEvent(event: unknown): event is ProviderFallbackTriggeredEvent {
  if (!event || typeof event !== "object") {
    return false
  }

  const record = event as Record<string, unknown>
  return record.type === "provider.fallback_triggered"
    && typeof record.sessionId === "string"
    && typeof record.runId === "string"
    && typeof record.fromProvider === "string"
    && typeof record.toProvider === "string"
    && typeof record.errorType === "string"
    && typeof record.attemptNumber === "number"
}
