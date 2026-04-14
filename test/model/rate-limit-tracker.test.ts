import { describe, expect, test } from "bun:test"

import {
  RateLimitTracker,
  type ModelObserverEvent,
} from "../../src/model"

describe("RateLimitTracker", () => {
  test("parses the standard OpenAI-compatible request and token headers", () => {
    const tracker = new RateLimitTracker({
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    })

    tracker.update({
      "x-ratelimit-limit-requests": "120",
      "x-ratelimit-remaining-requests": "30",
      "x-ratelimit-reset-requests": "60s",
      "x-ratelimit-limit-tokens": "120000",
      "x-ratelimit-remaining-tokens": "60000",
      "x-ratelimit-reset-tokens": "120s",
    })

    expect(tracker.get()).toEqual({
      rpm: {
        limit: 120,
        remaining: 30,
        reset: new Date("2026-04-15T00:01:00.000Z"),
      },
      tpm: {
        limit: 120000,
        remaining: 60000,
        reset: new Date("2026-04-15T00:02:00.000Z"),
      },
    })
  })

  test("parses case-insensitive headers and compact duration resets", () => {
    const tracker = new RateLimitTracker({
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    })

    tracker.update({
      "X-RateLimit-Limit-Requests": "60",
      "X-RateLimit-Remaining-Requests": "10",
      "X-RateLimit-Reset-Requests": "1m2s",
    })

    expect(tracker.get().rpm).toEqual({
      limit: 60,
      remaining: 10,
      reset: new Date("2026-04-15T00:01:02.000Z"),
    })
  })

  test("detects near-limit ratios and emits telemetry", () => {
    const observedEvents: ModelObserverEvent[] = []
    const tracker = new RateLimitTracker({
      now: () => new Date("2026-04-15T00:00:00.000Z"),
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

    tracker.update({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "5",
      "x-ratelimit-reset-requests": "30s",
      "x-ratelimit-limit-tokens": "1000",
      "x-ratelimit-remaining-tokens": "250",
      "x-ratelimit-reset-tokens": "30s",
    })

    expect(tracker.isNearLimit(0.1)).toBe(true)
    expect(observedEvents).toContainEqual({
      type: "rate_limit.near_threshold",
      sessionId: "session_1",
      runId: "run_1",
      turnKey: "run_1:turn_1",
      rpm_remaining: 5,
      tpm_remaining: 250,
      threshold: 0.1,
    })
  })

  test("returns false when all windows are comfortably above the threshold", () => {
    const tracker = new RateLimitTracker({
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    })

    tracker.update({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "50",
      "x-ratelimit-reset-requests": "30s",
      "x-ratelimit-limit-tokens": "1000",
      "x-ratelimit-remaining-tokens": "600",
      "x-ratelimit-reset-tokens": "30s",
    })

    expect(tracker.isNearLimit(0.1)).toBe(false)
  })

  test("supports absolute remaining thresholds", () => {
    const tracker = new RateLimitTracker({
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    })

    tracker.update({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "4",
      "x-ratelimit-reset-requests": "30s",
    })

    expect(tracker.isNearLimit(5)).toBe(true)
    expect(tracker.isNearLimit(3)).toBe(false)
  })

  test("formats tracked windows into a readable summary", () => {
    const tracker = new RateLimitTracker({
      now: () => new Date("2026-04-15T00:00:00.000Z"),
    })

    tracker.update({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "4",
      "x-ratelimit-reset-requests": "30s",
      "x-ratelimit-limit-tokens": "1000",
      "x-ratelimit-remaining-tokens": "300",
      "x-ratelimit-reset-tokens": "60s",
    })

    expect(tracker.format()).toBe(
      "RPM: 4/100 remaining (reset 2026-04-15T00:00:30.000Z); TPM: 300/1000 remaining (reset 2026-04-15T00:01:00.000Z)",
    )
  })
})
