import { createHash } from "node:crypto"
import {
  buildSystemReminderPayloadText,
  buildModelTurnProjection,
  buildStaticSystemPrompt,
  buildModelPromptSections,
  projectModelTurn,
} from "./projection"
import { estimateModelTurnUsage } from "./token-usage"
import type { ModelObserverPort } from "./ports/model-observer"
import { classifyError } from "../domain/error-classification"
import type {
  ModelEvent,
  ModelProjectionInput,
} from "../domain"
import type { ClassifiedError } from "../domain/error-classification"
import type {
  Provider,
  ProviderTurnRequest,
} from "./ports/provider"

export type CreateModelRuntimeApiInput = Provider | {
  provider: Provider
  rateLimitTracker?: {
    update(headers: Record<string, string>): void
    isNearLimit(threshold?: number): boolean
  }
}

export function createModelRuntimeApi(input: CreateModelRuntimeApiInput) {
  const providerInput = resolveProviderInput(input)

  return {
    projectTurn(request: ModelProjectionInput & Pick<ProviderTurnRequest, "signal">) {
      return projectModelTurn(request)
    },
    async *streamTurn(request: ProviderTurnRequest) {
      const stream = providerInput.provider.streamTurn(request)
      updateRateLimitsFromMetadata(providerInput.rateLimitTracker, stream)

      try {
        for await (const event of stream) {
          yield event
        }
      } catch (error) {
        updateRateLimitsFromMetadata(providerInput.rateLimitTracker, error)
        throw attachClassifiedError(normalizeClassifiedError(error))
      }
    },
  }
}

export type ModelRuntimeApi = ReturnType<typeof createModelRuntimeApi>

export type ModelProviderRequest = ModelProjectionInput &
  Pick<ProviderTurnRequest, "signal" | "temperature" | "thinking"> & {
    sessionId?: string
    runId?: string
    turnKey?: string
  }

export type ModelProvider = {
  projectTurn(request: ModelProjectionInput & Pick<ProviderTurnRequest, "temperature">): {
    inputTokens: number
  }
  streamTurn(request: ModelProviderRequest): AsyncIterable<ModelEvent>
  continueWithoutThinking?(input: { sessionId: string }): void
  restoreThinking?(input: { sessionId: string }): void
}

export function createModelProvider(input: {
  runtime: ModelRuntimeApi
  observer?: ModelObserverPort
  replayGuard?: unknown
}): ModelProvider {
  const sessionThinkingOverrides = new Set<string>()

  return {
    projectTurn(request) {
      const projected = buildModelTurnProjection(request)
      const usage = estimateModelTurnUsage({
        request: projected.request,
        outputEvents: [],
      })
      return {
        inputTokens: usage.inputTokens,
      }
    },
    async *streamTurn(request) {
      const effectiveThinking =
        request.sessionId && sessionThinkingOverrides.has(request.sessionId)
          ? { enabled: false as const }
          : request.thinking
      const projected = buildModelTurnProjection(request)

      if (request.sessionId && request.runId) {
        try {
          input.observer?.recordModelEvent?.({
            type: "model.turn.requested",
            sessionId: request.sessionId,
            runId: request.runId,
            turnKey: request.turnKey,
          })
          const projected = buildModelTurnProjection(request)
          const sections = buildModelPromptSections({
            systemPrompt: request.systemPrompt,
            lateContextMessage: request.lateContextMessage,
            skillCatalog: request.skillCatalog,
            activeSkills: request.activeSkills,
            systemReminders: request.systemReminders,
          })
          const systemPrompt = buildStaticSystemPrompt(sections)
          const systemReminderPayload = buildSystemReminderPayloadText(sections.systemReminderMessages)
          if (projected.microcompact) {
            input.observer?.recordModelEvent?.({
              type: "microcompact.applied",
              sessionId: request.sessionId,
              runId: request.runId,
              turnKey: request.turnKey ?? `${request.runId}:turn_unkeyed`,
              clearedCount: projected.microcompact.clearedCount,
              retainedCount: projected.microcompact.retainedCount,
              estimatedTokensSaved: projected.microcompact.estimatedTokensSaved,
            })
          }
          input.observer?.recordModelEvent?.({
            type: "model.prompt.assembled",
            sessionId: request.sessionId,
            runId: request.runId,
            turnKey: request.turnKey ?? `${request.runId}:turn_unkeyed`,
            catalogSkillNames: request.systemReminderMetadata?.catalogSkillNames ?? [],
            activeSkillNames: request.systemReminderMetadata?.activeSkillNames ?? [],
            activeSkillCount: request.systemReminderMetadata?.activeSkillNames.length ?? 0,
            recoveryFilePaths: request.systemReminderMetadata?.recoveryFilePaths ?? [],
            systemPromptHash: hashPromptSection(systemPrompt),
            systemPromptLength: systemPrompt.length,
            systemReminderHash: systemReminderPayload ? hashPromptSection(systemReminderPayload) : null,
            systemReminderLength: systemReminderPayload?.length ?? null,
          })
        } catch {
          // Observability must not alter the model request path.
        }
      }

      const outputEvents: Array<Extract<ModelEvent, { type: "text.delta" | "reasoning.delta" | "tool.call" }>> = []
      let observedUsage = false

      try {
        for await (const event of input.runtime.streamTurn({
          ...projected.request,
          signal: request.signal,
          ...(effectiveThinking !== undefined && { thinking: effectiveThinking }),
        })) {
          if (event.type === "usage") {
            observedUsage = true
            observeTurnUsage({
              observer: input.observer,
              request,
              usage: event,
            })
            yield event
            continue
          }

          if (event.type === "text.delta" || event.type === "reasoning.delta" || event.type === "tool.call") {
            outputEvents.push(event)
          }

          yield event
        }
      } catch (error) {
        if (!observedUsage && outputEvents.length > 0) {
          const estimatedUsage = estimateModelTurnUsage({
            request: projected.request,
            outputEvents,
          })
          observeTurnUsage({
            observer: input.observer,
            request,
            usage: estimatedUsage,
          })
          yield estimatedUsage
        }

        observeClassifiedError({
          observer: input.observer,
          request,
          error,
        })

        throw error
      }

      if (!observedUsage) {
        const estimatedUsage = estimateModelTurnUsage({
          request: projected.request,
          outputEvents,
        })
        observeTurnUsage({
          observer: input.observer,
          request,
          usage: estimatedUsage,
        })
        yield estimatedUsage
      }
    },
    continueWithoutThinking(inputValue) {
      sessionThinkingOverrides.add(inputValue.sessionId)
    },
    restoreThinking(inputValue) {
      sessionThinkingOverrides.delete(inputValue.sessionId)
    },
  }
}

function hashPromptSection(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function observeTurnUsage(input: {
  observer?: ModelObserverPort
  request: ModelProviderRequest
  usage: Extract<ModelEvent, { type: "usage" }>
}) {
  if (!input.request.sessionId || !input.request.runId) {
    return
  }

  try {
    input.observer?.recordModelEvent?.({
      type: "model.turn.usage",
      sessionId: input.request.sessionId,
      runId: input.request.runId,
      turnKey: input.request.turnKey ?? `${input.request.runId}:turn_unkeyed`,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      tokenUsageSource: input.usage.source,
    })
  } catch {
    // Observability must not alter the model request path.
  }
}

function observeClassifiedError(input: {
  observer?: ModelObserverPort
  request: ModelProviderRequest
  error: unknown
}) {
  if (!input.request.sessionId || !input.request.runId) {
    return
  }

  const classified = classifyError(coerceError(input.error))

  try {
    input.observer?.recordModelEvent?.({
      type: "error.classified",
      sessionId: input.request.sessionId,
      runId: input.request.runId,
      turnKey: input.request.turnKey ?? `${input.request.runId}:turn_unkeyed`,
      errorType: classified.reason,
      severity: classified.retryable
        || classified.shouldCompress
        || classified.shouldRotateCredential
        || classified.shouldFallback
        ? "warning"
        : "error",
      shouldRetry: classified.retryable,
      shouldRotateCredential: classified.shouldRotateCredential,
      shouldFallback: classified.shouldFallback,
    })
  } catch {
    // Observability must not alter the model request path.
  }
}

function resolveProviderInput(input: CreateModelRuntimeApiInput) {
  return "provider" in input
    ? input
    : {
        provider: input,
      }
}

function normalizeClassifiedError(error: unknown): ClassifiedError {
  const attached = readAttachedClassification(error)
  if (attached) {
    return attached
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

function readAttachedClassification(error: unknown) {
  if (!error || typeof error !== "object") {
    return null
  }

  const classified = (error as { classified?: unknown }).classified
  return isClassifiedError(classified) ? classified : null
}

function attachClassifiedError(classified: ClassifiedError) {
  const error = classified.original as Error & { classified?: ClassifiedError }
  error.classified = classified
  return error
}

function updateRateLimitsFromMetadata(
  tracker:
    | {
        update(headers: Record<string, string>): void
        isNearLimit(threshold?: number): boolean
      }
    | undefined,
  value: unknown,
) {
  const headers = readHeaderRecord(value)
  if (!tracker || !headers) {
    return
  }

  tracker.update(headers)
  tracker.isNearLimit()
}

function readHeaderRecord(value: unknown): Record<string, string> | undefined {
  const directHeaders = readHeadersContainer(value)
  if (directHeaders) {
    return directHeaders
  }

  if (!value || typeof value !== "object") {
    return undefined
  }

  const response = (value as Record<string, unknown>).response
  return readHeadersContainer(response)
}

function readHeadersContainer(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const headers = (value as Record<string, unknown>).headers
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries())
  }

  if (!headers || typeof headers !== "object") {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function coerceError(error: unknown) {
  if (isClassifiedError(error)) {
    return error.original
  }

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
