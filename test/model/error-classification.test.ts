import { describe, expect, test } from "bun:test"

import {
  FailoverReason,
  classifyError,
} from "../../src/model"
import type { ClassifiedError } from "../../src/model"

function makeError(
  message: string,
  options: {
    name?: string
  } = {},
) {
  const error = new Error(message)
  error.name = options.name ?? "Error"
  return error
}

function expectClassification(
  classified: ClassifiedError,
  expected: Partial<ClassifiedError> & { reason: FailoverReason },
) {
  expect(classified.reason).toBe(expected.reason)
  expect(classified.original instanceof Error).toBe(true)

  for (const [key, value] of Object.entries(expected)) {
    expect(classified[key as keyof ClassifiedError]).toEqual(value)
  }
}

describe("classifyError", () => {
  test("classifies 401 as auth and rotates credentials", () => {
    expectClassification(classifyError(makeError("Unauthorized"), 401), {
      reason: FailoverReason.auth,
      statusCode: 401,
      retryable: false,
      shouldCompress: false,
      shouldRotateCredential: true,
      shouldFallback: true,
    })
  })

  test("classifies 402 as billing by default", () => {
    expectClassification(classifyError(makeError("Payment required"), 402), {
      reason: FailoverReason.billing,
      statusCode: 402,
      retryable: false,
      shouldCompress: false,
      shouldRotateCredential: true,
      shouldFallback: true,
    })
  })

  test("classifies transient usage-limit 402 messages as rate limits", () => {
    expectClassification(
      classifyError(makeError("Usage limit exceeded, try again in 5 minutes"), 402),
      {
        reason: FailoverReason.rate_limit,
        statusCode: 402,
        retryable: true,
        shouldRotateCredential: true,
        shouldFallback: true,
      },
    )
  })

  test("classifies 429 as rate limit and parses retry-after hints", () => {
    expectClassification(
      classifyError(makeError("Too many requests, retry after 2 seconds"), 429),
      {
        reason: FailoverReason.rate_limit,
        statusCode: 429,
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: true,
        retryAfterMs: 2000,
      },
    )
  })

  test("classifies 503 as overloaded", () => {
    expectClassification(classifyError(makeError("Service unavailable"), 503), {
      reason: FailoverReason.overloaded,
      statusCode: 503,
      retryable: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      shouldFallback: false,
    })
  })

  test("classifies 500-class failures as server errors", () => {
    expectClassification(classifyError(makeError("Internal server error"), 500), {
      reason: FailoverReason.server_error,
      statusCode: 500,
      retryable: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      shouldFallback: false,
    })
  })

  test("classifies timeout-style errors from error names", () => {
    expectClassification(
      classifyError(makeError("Request timed out", { name: "APITimeoutError" })),
      {
        reason: FailoverReason.timeout,
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
      },
    )
  })

  test("classifies context overflow messages and recommends compression", () => {
    expectClassification(
      classifyError(makeError("This prompt exceeds the model context window"), 400),
      {
        reason: FailoverReason.context_overflow,
        statusCode: 400,
        retryable: true,
        shouldCompress: true,
        shouldRotateCredential: false,
        shouldFallback: false,
      },
    )
  })

  test("classifies invalid model messages as model_not_found", () => {
    expectClassification(classifyError(makeError("The requested model is not a valid model"), 404), {
      reason: FailoverReason.model_not_found,
      statusCode: 404,
      retryable: false,
      shouldCompress: false,
      shouldRotateCredential: false,
      shouldFallback: true,
    })
  })

  test("falls back to safe defaults for unknown errors", () => {
    expectClassification(classifyError(makeError("Something odd happened")), {
      reason: FailoverReason.unknown,
      retryable: false,
      shouldCompress: false,
      shouldRotateCredential: false,
      shouldFallback: false,
      retryAfterMs: undefined,
      statusCode: undefined,
    })
  })
})
