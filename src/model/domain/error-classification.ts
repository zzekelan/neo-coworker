const BILLING_PATTERNS = [
  "insufficient credits",
  "insufficient_quota",
  "credit balance",
  "credits have been exhausted",
  "top up your credits",
  "payment required",
  "billing hard limit",
  "exceeded your current quota",
  "account is deactivated",
  "plan does not include",
] as const

const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "throttled",
  "requests per minute",
  "tokens per minute",
  "requests per day",
  "try again in",
  "please retry after",
  "resource_exhausted",
  "rate increased too quickly",
] as const

const USAGE_LIMIT_PATTERNS = [
  "usage limit",
  "quota",
  "limit exceeded",
  "key limit exceeded",
] as const

const USAGE_LIMIT_TRANSIENT_SIGNALS = [
  "try again",
  "retry",
  "resets at",
  "reset in",
  "wait",
  "requests remaining",
  "periodic",
  "window",
] as const

const CONTEXT_OVERFLOW_PATTERNS = [
  "context length",
  "context size",
  "maximum context",
  "token limit",
  "too many tokens",
  "reduce the length",
  "exceeds the limit",
  "context window",
  "prompt is too long",
  "prompt exceeds max length",
  "max_tokens",
  "maximum number of tokens",
  "exceeds the max_model_len",
  "max_model_len",
  "prompt length",
  "input is too long",
  "maximum model length",
  "context length exceeded",
  "truncating input",
  "slot context",
  "n_ctx_slot",
  "超过最大长度",
  "上下文长度",
] as const

const MODEL_NOT_FOUND_PATTERNS = [
  "is not a valid model",
  "invalid model",
  "model not found",
  "model_not_found",
  "does not exist",
  "no such model",
  "unknown model",
  "unsupported model",
] as const

const AUTH_PATTERNS = [
  "invalid api key",
  "invalid_api_key",
  "authentication",
  "unauthorized",
  "forbidden",
  "invalid token",
  "token expired",
  "token revoked",
  "access denied",
] as const

const OVERLOADED_PATTERNS = [
  "overloaded",
  "service unavailable",
  "temporarily unavailable",
  "server is busy",
  "capacity",
] as const

const TIMEOUT_PATTERNS = [
  "timed out",
  "timeout",
  "connection reset by peer",
  "connection was closed",
  "server disconnected",
  "network connection lost",
  "unexpected eof",
] as const

const TIMEOUT_ERROR_NAMES = new Set([
  "ReadTimeout",
  "ConnectTimeout",
  "PoolTimeout",
  "ConnectError",
  "RemoteProtocolError",
  "ConnectionError",
  "ConnectionResetError",
  "ConnectionAbortedError",
  "BrokenPipeError",
  "TimeoutError",
  "ReadError",
  "ServerDisconnectedError",
  "APIConnectionError",
  "APITimeoutError",
])

export enum FailoverReason {
  auth = "auth",
  billing = "billing",
  rate_limit = "rate_limit",
  overloaded = "overloaded",
  server_error = "server_error",
  timeout = "timeout",
  context_overflow = "context_overflow",
  model_not_found = "model_not_found",
  unknown = "unknown",
}

export type ClassifiedError = {
  reason: FailoverReason
  original: Error
  statusCode?: number
  retryable: boolean
  shouldCompress: boolean
  shouldRotateCredential: boolean
  shouldFallback: boolean
  retryAfterMs?: number
}

export function classifyError(error: Error, statusCode?: number): ClassifiedError {
  const resolvedStatusCode = statusCode ?? readStatusCode(error)
  const message = readErrorMessage(error)
  const normalizedMessage = message.toLowerCase()

  if (resolvedStatusCode === 401 || includesAny(normalizedMessage, AUTH_PATTERNS)) {
    return buildClassifiedError(error, FailoverReason.auth, {
      statusCode: resolvedStatusCode,
      retryable: false,
      shouldRotateCredential: true,
      shouldFallback: true,
    })
  }

  if (resolvedStatusCode === 402) {
    return classify402(error, resolvedStatusCode, normalizedMessage)
  }

  if (resolvedStatusCode === 404 || includesAny(normalizedMessage, MODEL_NOT_FOUND_PATTERNS)) {
    return buildClassifiedError(error, FailoverReason.model_not_found, {
      statusCode: resolvedStatusCode,
      retryable: false,
      shouldFallback: true,
    })
  }

  if (resolvedStatusCode === 429) {
    return buildClassifiedError(error, FailoverReason.rate_limit, {
      statusCode: resolvedStatusCode,
      retryable: true,
      shouldRotateCredential: true,
      shouldFallback: true,
      retryAfterMs: parseRetryAfterMs(normalizedMessage),
    })
  }

  if (resolvedStatusCode === 408 || resolvedStatusCode === 504) {
    return buildClassifiedError(error, FailoverReason.timeout, {
      statusCode: resolvedStatusCode,
      retryable: true,
    })
  }

  if (resolvedStatusCode === 503 || resolvedStatusCode === 529 || includesAny(normalizedMessage, OVERLOADED_PATTERNS)) {
    return buildClassifiedError(error, FailoverReason.overloaded, {
      statusCode: resolvedStatusCode,
      retryable: true,
    })
  }

  if (
    resolvedStatusCode === 400
    || resolvedStatusCode === 413
    || includesAny(normalizedMessage, CONTEXT_OVERFLOW_PATTERNS)
  ) {
    const contextOverflow = classifyContextOr400(error, resolvedStatusCode, normalizedMessage)
    if (contextOverflow) {
      return contextOverflow
    }
  }

  if (includesUsageLimit(normalizedMessage)) {
    if (includesAny(normalizedMessage, USAGE_LIMIT_TRANSIENT_SIGNALS)) {
      return buildClassifiedError(error, FailoverReason.rate_limit, {
        statusCode: resolvedStatusCode,
        retryable: true,
        shouldRotateCredential: true,
        shouldFallback: true,
        retryAfterMs: parseRetryAfterMs(normalizedMessage),
      })
    }

    return buildClassifiedError(error, FailoverReason.billing, {
      statusCode: resolvedStatusCode,
      retryable: false,
      shouldRotateCredential: true,
      shouldFallback: true,
    })
  }

  if (includesAny(normalizedMessage, BILLING_PATTERNS)) {
    return buildClassifiedError(error, FailoverReason.billing, {
      statusCode: resolvedStatusCode,
      retryable: false,
      shouldRotateCredential: true,
      shouldFallback: true,
    })
  }

  if (includesAny(normalizedMessage, RATE_LIMIT_PATTERNS)) {
    return buildClassifiedError(error, FailoverReason.rate_limit, {
      statusCode: resolvedStatusCode,
      retryable: true,
      shouldRotateCredential: true,
      shouldFallback: true,
      retryAfterMs: parseRetryAfterMs(normalizedMessage),
    })
  }

  if (resolvedStatusCode !== undefined && resolvedStatusCode >= 500 && resolvedStatusCode < 600) {
    return buildClassifiedError(error, FailoverReason.server_error, {
      statusCode: resolvedStatusCode,
      retryable: true,
    })
  }

  if (TIMEOUT_ERROR_NAMES.has(error.name) || includesAny(normalizedMessage, TIMEOUT_PATTERNS)) {
    return buildClassifiedError(error, FailoverReason.timeout, {
      statusCode: resolvedStatusCode,
      retryable: true,
    })
  }

  return buildClassifiedError(error, FailoverReason.unknown, {
    statusCode: resolvedStatusCode,
    retryable: false,
  })
}

function classify402(error: Error, statusCode: number, normalizedMessage: string) {
  if (includesUsageLimit(normalizedMessage) && includesAny(normalizedMessage, USAGE_LIMIT_TRANSIENT_SIGNALS)) {
    return buildClassifiedError(error, FailoverReason.rate_limit, {
      statusCode,
      retryable: true,
      shouldRotateCredential: true,
      shouldFallback: true,
      retryAfterMs: parseRetryAfterMs(normalizedMessage),
    })
  }

  return buildClassifiedError(error, FailoverReason.billing, {
    statusCode,
    retryable: false,
    shouldRotateCredential: true,
    shouldFallback: true,
  })
}

function classifyContextOr400(error: Error, statusCode: number | undefined, normalizedMessage: string) {
  if (includesAny(normalizedMessage, CONTEXT_OVERFLOW_PATTERNS) || statusCode === 413) {
    return buildClassifiedError(error, FailoverReason.context_overflow, {
      statusCode,
      retryable: true,
      shouldCompress: true,
    })
  }

  if (includesAny(normalizedMessage, MODEL_NOT_FOUND_PATTERNS)) {
    return buildClassifiedError(error, FailoverReason.model_not_found, {
      statusCode,
      retryable: false,
      shouldFallback: true,
    })
  }

  if (includesAny(normalizedMessage, RATE_LIMIT_PATTERNS)) {
    return buildClassifiedError(error, FailoverReason.rate_limit, {
      statusCode,
      retryable: true,
      shouldRotateCredential: true,
      shouldFallback: true,
      retryAfterMs: parseRetryAfterMs(normalizedMessage),
    })
  }

  if (includesAny(normalizedMessage, BILLING_PATTERNS)) {
    return buildClassifiedError(error, FailoverReason.billing, {
      statusCode,
      retryable: false,
      shouldRotateCredential: true,
      shouldFallback: true,
    })
  }

  return undefined
}

function buildClassifiedError(
  error: Error,
  reason: FailoverReason,
  overrides: Partial<ClassifiedError>,
): ClassifiedError {
  return {
    reason,
    original: error,
    statusCode: undefined,
    retryable: false,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
    ...overrides,
  }
}

function includesUsageLimit(message: string) {
  return includesAny(message, USAGE_LIMIT_PATTERNS)
}

function includesAny(message: string, patterns: readonly string[]) {
  return patterns.some((pattern) => message.includes(pattern))
}

function parseRetryAfterMs(message: string) {
  const match = message.match(/(?:retry after|try again in|reset in)\s+(\d+)\s*(ms|milliseconds?|s|sec|seconds?|m|minutes?)/)

  if (!match) {
    return undefined
  }

  const value = Number(match[1])
  const unit = match[2]

  if (Number.isNaN(value)) {
    return undefined
  }

  if (unit === "ms" || unit.startsWith("millisecond")) {
    return value
  }

  if (unit === "m" || unit.startsWith("minute")) {
    return value * 60_000
  }

  return value * 1000
}

function readStatusCode(error: Error) {
  const errorWithStatus = error as Error & {
    statusCode?: unknown
    status?: unknown
  }

  if (typeof errorWithStatus.statusCode === "number") {
    return errorWithStatus.statusCode
  }

  if (typeof errorWithStatus.status === "number") {
    return errorWithStatus.status
  }

  return undefined
}

function readErrorMessage(error: Error) {
  const bodyMessage = readBodyMessage(error)

  if (!bodyMessage) {
    return error.message
  }

  if (bodyMessage === error.message) {
    return error.message
  }

  return `${error.message} ${bodyMessage}`.trim()
}

function readBodyMessage(error: Error) {
  const body = (error as Error & { body?: unknown }).body

  if (!body || typeof body !== "object") {
    return ""
  }

  const message = readNestedMessage(body)
  return typeof message === "string" ? message : ""
}

function readNestedMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  if (typeof record.message === "string" && record.message.length > 0) {
    return record.message
  }

  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === "string" && nested.message.length > 0) {
      return nested.message
    }
  }

  return undefined
}
