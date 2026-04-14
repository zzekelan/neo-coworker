import { describe, expect, test } from "bun:test"

import {
  CredentialPool,
  FailoverReason,
  PoolStrategy,
  type ModelObserverEvent,
} from "../../src/model"

describe("CredentialPool", () => {
  test("fill_first returns the first available credential", () => {
    const pool = new CredentialPool(["key-a", "key-b"], PoolStrategy.fill_first)

    expect(pool.next()).toEqual({
      key: "key-a",
      usageCount: 0,
      cooldownUntil: undefined,
      lastError: undefined,
    })
  })

  test("fill_first skips credentials that are cooling down", () => {
    const now = { value: 0 }
    const pool = new CredentialPool(["key-a", "key-b"], PoolStrategy.fill_first, {
      now: () => new Date(now.value),
    })

    pool.markFailed("key-a", FailoverReason.rate_limit, 30_000)

    expect(pool.next()?.key).toBe("key-b")
  })

  test("fill_first returns cooled-down credentials again once the cooldown expires", () => {
    const now = { value: 0 }
    const pool = new CredentialPool(["key-a", "key-b"], PoolStrategy.fill_first, {
      now: () => new Date(now.value),
    })

    pool.markFailed("key-a", FailoverReason.rate_limit, 1_000)
    expect(pool.next()?.key).toBe("key-b")

    now.value = 1_001

    expect(pool.next()?.key).toBe("key-a")
  })

  test("round_robin rotates through available credentials", () => {
    const pool = new CredentialPool(["key-a", "key-b", "key-c"], PoolStrategy.round_robin)

    expect(pool.next()?.key).toBe("key-a")
    expect(pool.next()?.key).toBe("key-b")
    expect(pool.next()?.key).toBe("key-c")
    expect(pool.next()?.key).toBe("key-a")
  })

  test("least_used prefers credentials with fewer successful uses", () => {
    const pool = new CredentialPool(["key-a", "key-b", "key-c"], PoolStrategy.least_used)

    expect(pool.next()?.key).toBe("key-a")
    pool.markSuccess("key-a")

    expect(pool.next()?.key).toBe("key-b")
    pool.markSuccess("key-b")

    expect(pool.next()?.key).toBe("key-c")
  })

  test("markSuccess increments usage and clears failure state", () => {
    const now = { value: 0 }
    const pool = new CredentialPool(["key-a"], PoolStrategy.fill_first, {
      now: () => new Date(now.value),
    })

    pool.markFailed("key-a", FailoverReason.auth, 60_000)
    pool.markSuccess("key-a")

    expect(pool.next()).toEqual({
      key: "key-a",
      usageCount: 1,
      cooldownUntil: undefined,
      lastError: undefined,
    })
  })

  test("available counts only credentials outside cooldown", () => {
    const now = { value: 0 }
    const pool = new CredentialPool(["key-a", "key-b", "key-c"], PoolStrategy.fill_first, {
      now: () => new Date(now.value),
    })

    pool.markFailed("key-a", FailoverReason.rate_limit, 1_000)
    pool.markFailed("key-b", FailoverReason.rate_limit, 1_000)

    expect(pool.available()).toBe(1)

    now.value = 1_001

    expect(pool.available()).toBe(3)
  })

  test("emits credential.rotated after failure-driven selection", () => {
    const observedEvents: ModelObserverEvent[] = []
    const pool = new CredentialPool(["key-a", "key-b"], PoolStrategy.fill_first, {
      now: () => new Date(0),
      observer: {
        recordModelEvent(event) {
          observedEvents.push(event)
        },
      },
      telemetry: {
        sessionId: "session_1",
        runId: "run_1",
        turnKey: "run_1:turn_1",
      },
    })

    pool.markFailed("key-a", FailoverReason.rate_limit, 5_000)

    expect(pool.next()?.key).toBe("key-b")
    expect(observedEvents).toContainEqual({
      type: "credential.rotated",
      sessionId: "session_1",
      runId: "run_1",
      turnKey: "run_1:turn_1",
      failedKey: "key-a",
      nextKey: "key-b",
      reason: FailoverReason.rate_limit,
      remainingCredentials: 1,
    })
  })
})
