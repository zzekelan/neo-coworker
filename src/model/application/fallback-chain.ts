import type { ModelObserverPort } from "./ports/model-observer"
import type { Provider as ModelProviderAdapter } from "./ports/provider"
import {
  classifyError,
  type ClassifiedError,
} from "../domain/error-classification"

const DEFAULT_PROVIDER_COOLDOWN_MS = 30_000

export type { ModelProviderAdapter }

export type FallbackProvider = {
  name: string
  createAdapter: () => ModelProviderAdapter
  priority: number
}

export type FallbackChainTelemetryContext = {
  sessionId?: string
  runId?: string
  turnKey?: string
}

export type ProviderFallbackTriggeredEvent = {
  type: "provider.fallback_triggered"
  sessionId: string
  runId: string
  turnKey?: string
  fromProvider: string
  toProvider: string
  errorType: ClassifiedError["reason"]
  attemptNumber: number
}

export type FallbackChainOptions = {
  now?: () => Date
  cooldownMs?: number
  observer?: ModelObserverPort
  telemetry?: FallbackChainTelemetryContext
}

type StoredProvider = FallbackProvider & {
  order: number
  cooldownUntil?: Date
}

export class FallbackChain {
  private readonly providers: StoredProvider[]
  private readonly now: () => Date
  private readonly cooldownMs: number
  private readonly observer?: ModelObserverPort
  private readonly telemetry?: FallbackChainTelemetryContext

  constructor(
    providers: FallbackProvider[],
    options: FallbackChainOptions = {},
  ) {
    this.providers = providers
      .map((provider, order) => ({
        ...provider,
        order,
      }))
      .sort((left, right) => left.priority - right.priority || left.order - right.order)
    this.now = options.now ?? (() => new Date())
    this.cooldownMs = Number.isFinite(options.cooldownMs)
      ? Math.max(0, options.cooldownMs ?? 0)
      : DEFAULT_PROVIDER_COOLDOWN_MS
    this.observer = options.observer
    this.telemetry = options.telemetry
  }

  execute<T>(fn: (adapter: ModelProviderAdapter) => Promise<T>): Promise<T>
  execute<T>(
    fn: (adapter: ModelProviderAdapter) => Promise<T>,
    error: ClassifiedError,
  ): Promise<T>
  async execute<T>(
    fn: (adapter: ModelProviderAdapter) => Promise<T>,
    error?: ClassifiedError,
  ): Promise<T> {
    const failures: Error[] = []
    const failedProviderNames: string[] = []
    let fallbackAttemptNumber = 0
    let previousFailure: {
      provider: StoredProvider
      error: ClassifiedError
    } | null = null
    let startIndex = 0

    if (error) {
      const primaryProvider = this.providers[0]

      failures.push(error.original)

      if (!primaryProvider) {
        throw buildAggregateFailure(failures, failedProviderNames)
      }

      failedProviderNames.push(primaryProvider.name)
      this.markFailed(primaryProvider, error)

      if (!error.shouldFallback) {
        throw error.original
      }

      previousFailure = {
        provider: primaryProvider,
        error,
      }
      startIndex = 1
    }

    for (let index = startIndex; index < this.providers.length; index += 1) {
      const provider = this.providers[index]
      if (!provider || this.isInCooldown(provider)) {
        continue
      }

      if (previousFailure) {
        fallbackAttemptNumber += 1
        this.emitFallbackTriggered({
          fromProvider: previousFailure.provider,
          toProvider: provider,
          error: previousFailure.error,
          attemptNumber: fallbackAttemptNumber,
        })
      }

      try {
        return await fn(provider.createAdapter())
      } catch (caughtError) {
        const classified = normalizeClassifiedError(caughtError)

        failures.push(classified.original)
        failedProviderNames.push(provider.name)
        this.markFailed(provider, classified)

        if (!classified.shouldFallback) {
          throw classified.original
        }

        previousFailure = {
          provider,
          error: classified,
        }
      }
    }

    throw buildAggregateFailure(failures, failedProviderNames)
  }

  private isInCooldown(provider: StoredProvider) {
    return provider.cooldownUntil != null && provider.cooldownUntil.getTime() > this.now().getTime()
  }

  private markFailed(provider: StoredProvider, error: ClassifiedError) {
    if (!error.shouldFallback) {
      return
    }

    const cooldownMs = Math.max(0, error.retryAfterMs ?? this.cooldownMs)
    provider.cooldownUntil = cooldownMs > 0
      ? new Date(this.now().getTime() + cooldownMs)
      : undefined
  }

  private emitFallbackTriggered(input: {
    fromProvider: StoredProvider
    toProvider: StoredProvider
    error: ClassifiedError
    attemptNumber: number
  }) {
    if (!this.telemetry?.sessionId || !this.telemetry.runId) {
      return
    }

    try {
      ;(this.observer as {
        recordModelEvent?(event: ProviderFallbackTriggeredEvent): void
      } | undefined)?.recordModelEvent?.({
        type: "provider.fallback_triggered",
        sessionId: this.telemetry.sessionId,
        runId: this.telemetry.runId,
        turnKey: this.telemetry.turnKey,
        fromProvider: input.fromProvider.name,
        toProvider: input.toProvider.name,
        errorType: input.error.reason,
        attemptNumber: input.attemptNumber,
      })
    } catch {}
  }
}

function buildAggregateFailure(errors: Error[], failedProviderNames: string[]) {
  const providerList = failedProviderNames.length > 0
    ? ` Failed providers: ${failedProviderNames.join(", ")}.`
    : ""

  return new AggregateError(
    errors,
    errors.length > 0
      ? `No model provider succeeded.${providerList}`
      : `No model providers are currently available.${providerList}`,
  )
}

function normalizeClassifiedError(error: unknown): ClassifiedError {
  if (isClassifiedError(error)) {
    return error
  }

  return classifyError(coerceError(error))
}

function isClassifiedError(error: unknown): error is ClassifiedError {
  if (!error || typeof error !== "object") {
    return false
  }

  const record = error as Record<string, unknown>
  return record.original instanceof Error
    && typeof record.reason === "string"
    && typeof record.retryable === "boolean"
    && typeof record.shouldCompress === "boolean"
    && typeof record.shouldRotateCredential === "boolean"
    && typeof record.shouldFallback === "boolean"
}

function coerceError(error: unknown) {
  if (error instanceof Error) {
    return error
  }

  const wrapped = new Error(
    typeof error === "object"
      && error !== null
      && "message" in error
      && typeof error.message === "string"
      ? error.message
      : String(error),
  )

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>

    if (typeof record.name === "string" && record.name.length > 0) {
      wrapped.name = record.name
    }

    if ("status" in record) {
      ;(wrapped as Error & { status?: unknown }).status = record.status
    }

    if ("statusCode" in record) {
      ;(wrapped as Error & { statusCode?: unknown }).statusCode = record.statusCode
    }

    if ("body" in record) {
      ;(wrapped as Error & { body?: unknown }).body = record.body
    }
  }

  return wrapped
}
