import OpenAI from "openai"
import {
  _resetModelsDevCatalogCache,
  getModelsDevCatalogCachePath,
  loadModelsDevCatalog,
  type LoadModelsDevCatalogInput,
} from "./provider-capability-catalog"
import {
  CredentialPool,
  PoolStrategy,
  RateLimitTracker,
  classifyError,
  createModelProvider,
  createModelRuntimeApi,
  createOpenAIAdapter,
  createOpenAICompatibleAdapter,
  type ClassifiedError,
  type ModelObserverPort,
  type ModelProvider,
  type OpenAICompatibleRequestConfig,
} from "../model"
import { readEnvWithFallback } from "./env"
import {
  MODELS_DEV_CAPABILITY_SNAPSHOT,
} from "./provider-capabilities-snapshot"
import {
  resolveProviderCapabilities as resolveProviderCapabilitiesFromCatalog,
  type ModelsDevCatalog,
  type ProviderCapabilityOverride,
  type ResolvedProviderCapabilities,
} from "./provider-capabilities"

type ProviderKind = "openai" | "openai-compatible"
type ReasoningEffortMode = "default" | "low" | "medium" | "high"
type ModelThinkingConfig = {
  enabled: boolean
  effort?: ReasoningEffortMode
}

type ProviderConfig = {
  provider: ProviderKind
  apiKey: string
  model: string
  baseURL?: string
  timeout?: number
}

type ContextWindowMetadata = {
  contextWindow: number
  source: "provider" | "models.dev" | "env" | "default"
}

type ReasoningConfig = {
  thinkingEnabled?: boolean
  reasoningEffort?: ReasoningEffortMode
}

type OpenAIClientConfig = Pick<ProviderConfig, "apiKey" | "baseURL" | "timeout">
type ModelProviderFactory = (input: {
  model: string
  client: OpenAI
  observer?: ModelObserverPort
}) => ModelProvider

export type DefaultProviderInput = {
  env?: Record<string, string | undefined>
  modelObserver?: ModelObserverPort
  replayGuard?: unknown
  resolvedCapabilities?: ResolvedProviderCapabilities
  createClient?: (config: OpenAIClientConfig) => OpenAI
  createOpenAIProviderImpl?: ModelProviderFactory
  createOpenAICompatibleProviderImpl?: ModelProviderFactory
  randomImpl?: () => number
  sleepImpl?: (delayMs: number) => Promise<void>
  retryAttempts?: number
}

const DEFAULT_PROVIDER_RETRY_ATTEMPTS = 3
const DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS = 250
const DEFAULT_PROVIDER_RETRY_MAX_DELAY_MS = 2_000
const DEFAULT_PROVIDER_RETRY_JITTER_RATIO = 0.25

function readEnvValue(
  env: Record<string, string | undefined>,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) {
      return value
    }
  }

  return undefined
}

function parseProviderKind(value: string | undefined): ProviderKind {
  if (!value) {
    throw new Error("LLM_PROVIDER is required")
  }

  if (value !== "openai" && value !== "openai-compatible") {
    throw new Error("LLM_PROVIDER must be one of: openai, openai-compatible")
  }

  return value
}

function parseTimeout(value: string | undefined) {
  if (value == null) {
    return undefined
  }

  if (!/^\d+$/.test(value)) {
    throw new Error("LLM_TIMEOUT_MS must be a valid integer when provided")
  }

  return Number.parseInt(value, 10)
}

function parsePositiveInteger(value: string | undefined, variableName: string) {
  if (value == null) {
    return undefined
  }

  if (!/^\d+$/.test(value) || value === "0") {
    throw new Error(`${variableName} must be a valid positive integer when provided`)
  }

  return Number.parseInt(value, 10)
}

function parseBoolean(value: string | undefined, variableName: string) {
  if (value == null) {
    return undefined
  }

  if (value === "true") {
    return true
  }

  if (value === "false") {
    return false
  }

  throw new Error(`${variableName} must be either true or false when provided`)
}

function parseReasoningEffortMode(value: string | undefined, variableName: string) {
  if (value == null) {
    return undefined
  }

  if (value === "default" || value === "low" || value === "medium" || value === "high") {
    return value
  }

  throw new Error(`${variableName} must be one of: default, low, medium, high when provided`)
}

export function resolveAgentServerOrigin(
  env: Record<string, string | undefined> = process.env,
) {
  const value = readEnvWithFallback(env, "NCOWORKER_SERVER_URL", "AGENT_SERVER_URL")
  if (!value) {
    return undefined
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("NCOWORKER_SERVER_URL must be a valid absolute URL")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NCOWORKER_SERVER_URL must use http or https")
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("NCOWORKER_SERVER_URL must not include a path, query, or hash")
  }

  return url.origin
}

export function resolveDefaultProviderConfig(
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  const provider = parseProviderKind(readEnvValue(env, "LLM_PROVIDER"))
  const apiKey = parseApiKeys(readEnvValue(env, "LLM_API_KEY"))[0]

  if (!apiKey) {
    throw new Error("LLM_API_KEY is required to run the CLI without an injected provider")
  }

  const baseURL = readEnvValue(env, "LLM_BASE_URL")
  if (provider === "openai-compatible" && !baseURL) {
    throw new Error("LLM_BASE_URL is required when LLM_PROVIDER=openai-compatible")
  }
  const model = readEnvValue(env, "LLM_MODEL")
  if (provider === "openai-compatible" && !model) {
    throw new Error("LLM_MODEL is required when LLM_PROVIDER=openai-compatible")
  }

  return {
    provider,
    apiKey,
    model: model ?? "gpt-5",
    baseURL,
    timeout: parseTimeout(readEnvValue(env, "LLM_TIMEOUT_MS")),
  }
}

export function resolveReasoningConfig(
  env: Record<string, string | undefined> = process.env,
): ReasoningConfig {
  const thinkingEnabled = parseBoolean(readEnvValue(env, "LLM_THINKING_ENABLED"), "LLM_THINKING_ENABLED")
  const reasoningEffort = parseReasoningEffortMode(
    readEnvValue(env, "LLM_REASONING_EFFORT"),
    "LLM_REASONING_EFFORT",
  )

  return {
    ...(thinkingEnabled === undefined ? {} : { thinkingEnabled }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

export function resolveReasoningCapabilityOverride(
  env: Record<string, string | undefined> = process.env,
  override?: ProviderCapabilityOverride,
): ProviderCapabilityOverride | undefined {
  const reasoningConfig = resolveReasoningConfig(env)
  const envOverride: ProviderCapabilityOverride = {
    ...(reasoningConfig.thinkingEnabled === undefined
      ? {}
      : { thinking: reasoningConfig.thinkingEnabled }),
    ...(reasoningConfig.reasoningEffort === undefined || reasoningConfig.reasoningEffort === "default"
      ? {}
      : { reasoningEffort: true }),
  }
  const merged = {
    ...envOverride,
    ...override,
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

export function resolveRuntimeThinkingConfig(input: {
  env?: Record<string, string | undefined>
  resolvedCapabilities?: ResolvedProviderCapabilities
}): ModelThinkingConfig | undefined {
  const env = input.env ?? process.env
  const reasoningConfig = resolveReasoningConfig(env)
  const supportsThinking = input.resolvedCapabilities?.thinkingControls.thinking.supported === true

  if (reasoningConfig.thinkingEnabled === false) {
    return { enabled: false }
  }

  if (reasoningConfig.thinkingEnabled !== true && !supportsThinking) {
    return undefined
  }

  return {
    enabled: true,
    ...(reasoningConfig.reasoningEffort === undefined
      ? {}
      : { effort: reasoningConfig.reasoningEffort }),
  }
}

export function resolveProviderCapabilities(input: {
  env?: Record<string, string | undefined>
  override?: ProviderCapabilityOverride
  catalog?: ModelsDevCatalog
} & Omit<LoadModelsDevCatalogInput, "env"> = {}): Promise<ResolvedProviderCapabilities> {
  const env = input.env ?? process.env
  const config = resolveDefaultProviderConfig(env)
  const override = resolveReasoningCapabilityOverride(env, input.override)

  return Promise.resolve(input.catalog ?? loadModelsDevCatalog({
    env,
    cwd: input.cwd,
    fetchImpl: input.fetchImpl,
    now: input.now,
    cachePath: input.cachePath,
    refreshIntervalMs: input.refreshIntervalMs,
    fetchTimeoutMs: input.fetchTimeoutMs,
    snapshot: input.snapshot,
  }).then((result) => result.catalog)).then((catalog) => resolveProviderCapabilitiesFromCatalog({
    config: {
      provider: config.provider,
      model: config.model,
      baseURL: config.baseURL,
    },
    override,
    catalog,
  }))
}

export {
  _resetModelsDevCatalogCache,
  getModelsDevCatalogCachePath,
  loadModelsDevCatalog,
  MODELS_DEV_CAPABILITY_SNAPSHOT,
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_CONTEXT_WINDOW_SIZE = 192_000
const DEFAULT_CONTEXT_WINDOW_METADATA_TIMEOUT_MS = 2_000

export async function resolveContextWindowSize(input: {
  env?: Record<string, string | undefined>
  catalog?: ModelsDevCatalog
  fetchImpl?: typeof fetch
  metadataTimeoutMs?: number
  cwd?: string
  now?: () => number
  cachePath?: string
  refreshIntervalMs?: number
  fetchTimeoutMs?: number
  snapshot?: ModelsDevCatalog
} = {}): Promise<ContextWindowMetadata> {
  const env = input.env ?? process.env
  const fetchImpl = input.fetchImpl ?? fetch
  const override = parsePositiveInteger(readEnvValue(env, "LLM_CONTEXT_WINDOW"), "LLM_CONTEXT_WINDOW")

  if (override) {
    return {
      contextWindow: override,
      source: "env",
    }
  }

  const config = resolveDefaultProviderConfig(env)
  const modelsDevContextWindow = await resolveModelsDevContextWindow({
    config,
    catalog: input.catalog,
    env,
    cwd: input.cwd,
    fetchImpl: input.fetchImpl,
    now: input.now,
    cachePath: input.cachePath,
    refreshIntervalMs: input.refreshIntervalMs,
    fetchTimeoutMs: input.fetchTimeoutMs,
    snapshot: input.snapshot,
  })
  let metadata: number | null = null

  try {
    metadata = await fetchContextWindowMetadata({
      config,
      fetchImpl,
      timeoutMs: input.metadataTimeoutMs ?? DEFAULT_CONTEXT_WINDOW_METADATA_TIMEOUT_MS,
    })
  } catch {
    metadata = null
  }

  if (metadata) {
    return {
      contextWindow: metadata,
      source: "provider",
    }
  }

  if (modelsDevContextWindow) {
    return {
      contextWindow: modelsDevContextWindow,
      source: "models.dev",
    }
  }

  return {
    contextWindow: DEFAULT_CONTEXT_WINDOW_SIZE,
    source: "default",
  }
}

export async function createDefaultProvider(
  input: DefaultProviderInput = {},
): Promise<ModelProvider> {
  const env = input.env ?? process.env
  const config = resolveDefaultProviderConfig(env)
  const apiKeys = parseApiKeys(readEnvValue(env, "LLM_API_KEY"))
  const createClient =
    input.createClient ??
    ((clientConfig: OpenAIClientConfig) =>
      new OpenAI({
        apiKey: clientConfig.apiKey,
        baseURL: clientConfig.baseURL,
          timeout: clientConfig.timeout,
        }))
  const createProviderForKey = createProviderFactory({
    config,
    resolvedCapabilities: input.resolvedCapabilities,
    createClient,
    createOpenAIProviderImpl: input.createOpenAIProviderImpl,
    createOpenAICompatibleProviderImpl: input.createOpenAICompatibleProviderImpl,
    observer: input.modelObserver,
  })
  const primaryProvider = createProviderForKey({ apiKey: config.apiKey })
  const credentialPool =
    apiKeys.length > 1 ? new CredentialPool(apiKeys, PoolStrategy.round_robin) : null

  return createResilientProvider({
    baseProvider: primaryProvider,
    primaryApiKey: config.apiKey,
    createProviderForKey,
    credentialPool,
    observer: input.modelObserver,
    random: input.randomImpl ?? Math.random,
    sleep: input.sleepImpl ?? sleep,
    retryAttempts: input.retryAttempts ?? DEFAULT_PROVIDER_RETRY_ATTEMPTS,
  })
}

function createProviderFactory(input: {
  config: ProviderConfig
  resolvedCapabilities?: ResolvedProviderCapabilities
  createClient: (config: OpenAIClientConfig) => OpenAI
  createOpenAIProviderImpl?: ModelProviderFactory
  createOpenAICompatibleProviderImpl?: ModelProviderFactory
  observer?: ModelObserverPort
}) {
  return (runtimeInput: {
    apiKey: string
    rateLimitTracker?: RateLimitTracker
  }) => {
    const client = input.createClient({
      apiKey: runtimeInput.apiKey,
      baseURL: input.config.baseURL,
      timeout: input.config.timeout,
    })

    if (input.config.provider === "openai-compatible") {
      const requestConfig = createOpenAICompatibleRequestConfig(input.resolvedCapabilities)

      if (input.createOpenAICompatibleProviderImpl) {
        return input.createOpenAICompatibleProviderImpl({
          model: input.config.model,
          client,
          observer: input.observer,
        })
      }

      return createModelProvider({
        runtime: createModelRuntimeApi({
          provider: createOpenAICompatibleAdapter({
            model: input.config.model,
            client,
            requestConfig,
          }),
          rateLimitTracker: runtimeInput.rateLimitTracker,
        }),
        observer: input.observer,
      })
    }

    if (input.createOpenAIProviderImpl) {
      return input.createOpenAIProviderImpl({
        model: input.config.model,
        client,
        observer: input.observer,
      })
    }

    return createModelProvider({
      runtime: createModelRuntimeApi({
        provider: createOpenAIAdapter({
          model: input.config.model,
          client,
        }),
        rateLimitTracker: runtimeInput.rateLimitTracker,
      }),
      observer: input.observer,
    })
  }
}

function createOpenAICompatibleRequestConfig(
  resolvedCapabilities: ResolvedProviderCapabilities | undefined,
): OpenAICompatibleRequestConfig | undefined {
  if (!resolvedCapabilities || resolvedCapabilities.provider !== "openai-compatible") {
    return undefined
  }

  const usesMiniMaxReasoningSplit = isMiniMaxReasoningModel(resolvedCapabilities)
  const supportsThinkingSerialization =
    resolvedCapabilities.thinkingControls.thinking.supported === true
    || resolvedCapabilities.reasoning.supported === true

  const requestConfig: OpenAICompatibleRequestConfig = {
    ...(resolvedCapabilities.interleaved.supported === true
      && resolvedCapabilities.interleaved.field
      && { replayedReasoningField: resolvedCapabilities.interleaved.field }),
    ...(usesMiniMaxReasoningSplit && {
      replayedReasoningField: "reasoning_details" as const,
      reasoningSplit: true,
    }),
    // An explicit config-level disable is not the same as the provider lacking
    // the thinking wire format. We still need to serialize `{ type: "disabled" }`
    // for reasoning-capable models like Kimi so the upstream default does not
    // silently re-enable thinking.
    ...(supportsThinkingSerialization && {
      serializeThinking: true,
    }),
    ...(resolvedCapabilities.thinkingControls.reasoningEffort.supported === true && {
      serializeReasoningEffort: true,
    }),
    ...((resolvedCapabilities.providerId === "moonshotai" || resolvedCapabilities.model.startsWith("kimi-"))
      && supportsThinkingSerialization && {
        disabledThinkingTemperature: 0.6,
        forcePreserveReasoning: true,
      }),
  }

  return Object.keys(requestConfig).length > 0 ? requestConfig : undefined
}

function isMiniMaxReasoningModel(resolvedCapabilities: ResolvedProviderCapabilities) {
  const providerId = resolvedCapabilities.providerId?.toLowerCase() ?? ""
  const model = resolvedCapabilities.model.toLowerCase()

  return model.includes("minimax-m2")
    || (providerId.includes("minimax") && /(^|[-_/])m2([.-]\d|$)/.test(model))
}

function createResilientProvider(input: {
  baseProvider: ModelProvider
  primaryApiKey: string
  createProviderForKey(input: {
    apiKey: string
    rateLimitTracker?: RateLimitTracker
  }): ModelProvider
  credentialPool: CredentialPool | null
  observer?: ModelObserverPort
  random: () => number
  sleep: (delayMs: number) => Promise<void>
  retryAttempts: number
}): ModelProvider {
  const sessionThinkingOverrides = new Set<string>()

  return {
    projectTurn(request) {
      return input.baseProvider.projectTurn(request)
    },
    async *streamTurn(request) {
      const effectiveRequest = request.sessionId && sessionThinkingOverrides.has(request.sessionId)
        ? {
            ...request,
            thinking: { enabled: false as const },
          }
        : request
      let apiKey = selectCredentialKey(input.credentialPool, input.primaryApiKey)
      let pendingRotation: { failedKey: string; reason: ClassifiedError["reason"] } | null = null
      const rateLimitTracker = createRateLimitTracker(input.observer, effectiveRequest)

      for (let attempt = 1; attempt <= input.retryAttempts; attempt += 1) {
        const provider = apiKey === input.primaryApiKey
          ? input.baseProvider
          : input.createProviderForKey({
              apiKey,
              rateLimitTracker,
            })
        let sawProviderOutput = false

        emitCredentialRotation(input.observer, request, pendingRotation, apiKey, input.credentialPool)
        pendingRotation = null

        try {
          for await (const event of provider.streamTurn(effectiveRequest)) {
            sawProviderOutput = true
            yield event
          }

          input.credentialPool?.markSuccess(apiKey)
          return
        } catch (error) {
          const classified = normalizeClassifiedError(error)

          if (!shouldRetryProviderRequest({
            attempt,
            sawProviderOutput,
            classified,
            retryAttempts: input.retryAttempts,
          })) {
            throw attachClassifiedError(classified)
          }

          if (input.credentialPool && classified.shouldRotateCredential) {
            input.credentialPool.markFailed(
              apiKey,
              classified.reason,
              classified.retryAfterMs ?? 0,
            )
            pendingRotation = {
              failedKey: apiKey,
              reason: classified.reason,
            }
            apiKey = selectCredentialKey(input.credentialPool, input.primaryApiKey)
          }

          await input.sleep(calculateRetryDelayMs({
            attempt,
            retryAfterMs: classified.retryAfterMs,
            random: input.random,
          }))
        }
      }
    },
    continueWithoutThinking(overrideInput) {
      sessionThinkingOverrides.add(overrideInput.sessionId)
      input.baseProvider.continueWithoutThinking?.(overrideInput)
    },
    restoreThinking(overrideInput) {
      sessionThinkingOverrides.delete(overrideInput.sessionId)
      input.baseProvider.restoreThinking?.(overrideInput)
    },
  }
}

function createRateLimitTracker(
  observer: ModelObserverPort | undefined,
  request: Parameters<ModelProvider["streamTurn"]>[0],
) {
  return new RateLimitTracker({
    observer,
    telemetry: request.sessionId && request.runId
      ? {
          sessionId: request.sessionId,
          runId: request.runId,
          turnKey: request.turnKey,
        }
      : undefined,
  })
}

function shouldRetryProviderRequest(input: {
  attempt: number
  sawProviderOutput: boolean
  classified: ClassifiedError
  retryAttempts: number
}) {
  return !input.sawProviderOutput
    && input.classified.retryable
    && input.attempt < input.retryAttempts
}

function calculateRetryDelayMs(input: {
  attempt: number
  retryAfterMs?: number
  random: () => number
}) {
  const exponentialDelay = Math.min(
    DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS * 2 ** (input.attempt - 1),
    DEFAULT_PROVIDER_RETRY_MAX_DELAY_MS,
  )
  const jitterWindow = Math.max(1, Math.floor(exponentialDelay * DEFAULT_PROVIDER_RETRY_JITTER_RATIO))
  const jitter = Math.floor(Math.max(0, input.random()) * jitterWindow)

  return Math.max(input.retryAfterMs ?? 0, Math.min(exponentialDelay + jitter, DEFAULT_PROVIDER_RETRY_MAX_DELAY_MS))
}

function selectCredentialKey(pool: CredentialPool | null, fallbackKey: string) {
  return pool?.next()?.key ?? fallbackKey
}

function emitCredentialRotation(
  observer: ModelObserverPort | undefined,
  request: Parameters<ModelProvider["streamTurn"]>[0],
  pendingRotation: { failedKey: string; reason: ClassifiedError["reason"] } | null,
  nextKey: string,
  credentialPool: CredentialPool | null,
) {
  if (!pendingRotation || pendingRotation.failedKey === nextKey || !request.sessionId || !request.runId) {
    return
  }

  try {
    observer?.recordModelEvent?.({
      type: "credential.rotated",
      sessionId: request.sessionId,
      runId: request.runId,
      turnKey: request.turnKey,
      failedKey: pendingRotation.failedKey,
      nextKey,
      reason: pendingRotation.reason,
      remainingCredentials: credentialPool?.available() ?? 1,
    })
  } catch {}
}

function parseApiKeys(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function normalizeClassifiedError(error: unknown): ClassifiedError {
  const attached = readAttachedClassification(error)
  if (attached) {
    return attached
  }

  return classifyError(coerceError(error))
}

function readAttachedClassification(error: unknown) {
  if (!error || typeof error !== "object") {
    return null
  }

  const classified = (error as { classified?: unknown }).classified
  return isClassifiedError(classified) ? classified : null
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

function attachClassifiedError(classified: ClassifiedError) {
  const error = classified.original as Error & { classified?: ClassifiedError }
  error.classified = classified
  return error
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

async function sleep(delayMs: number) {
  if (delayMs <= 0) {
    return
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

async function fetchContextWindowMetadata(input: {
  config: ProviderConfig
  fetchImpl: typeof fetch
  timeoutMs: number
}) {
  const baseURL = input.config.baseURL ?? DEFAULT_OPENAI_BASE_URL
  const requestUrl = new URL(
    `models/${encodeURIComponent(input.config.model)}`,
    ensureTrailingSlash(baseURL),
  )
  const abortController = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      abortController.abort()
      resolve(null)
    }, input.timeoutMs)
  })

  const response = await Promise.race([
    input.fetchImpl(requestUrl, {
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        Accept: "application/json",
      },
      signal: abortController.signal,
    }),
    timeoutPromise,
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
  })

  if (!response) {
    return null
  }

  if (!response.ok) {
    return null
  }

  const payload = await response.json()
  return readContextWindowFromPayload(payload)
}

async function resolveModelsDevContextWindow(input: {
  config: Pick<ProviderConfig, "provider" | "model" | "baseURL">
  catalog?: ModelsDevCatalog
  env: Record<string, string | undefined>
  cwd?: string
  fetchImpl?: typeof fetch
  now?: () => number
  cachePath?: string
  refreshIntervalMs?: number
  fetchTimeoutMs?: number
  snapshot?: ModelsDevCatalog
}) {
  const catalog = input.catalog ?? (await loadModelsDevCatalog({
    env: input.env,
    cwd: input.cwd,
    fetchImpl: input.fetchImpl,
    now: input.now,
    cachePath: input.cachePath,
    refreshIntervalMs: input.refreshIntervalMs,
    fetchTimeoutMs: input.fetchTimeoutMs,
    snapshot: input.snapshot,
  })).catalog
  const resolved = resolveProviderCapabilitiesFromCatalog({
    config: input.config,
    catalog,
  })
  const modelMetadata = resolved.providerId ? catalog[resolved.providerId]?.models[resolved.model] : undefined
  return readModelsDevContextWindow(modelMetadata)
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}

function readModelsDevContextWindow(modelMetadata: ModelsDevCatalog[string]["models"][string] | undefined) {
  const contextWindow = modelMetadata?.limit?.context
  return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : null
}

function readContextWindowFromPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const record = payload as Record<string, unknown>

  return (
    readNumericField(record, "context_length") ??
    readNumericField(record, "contextLength") ??
    readNumericField(record, "context_window") ??
    readNumericField(record, "contextWindow") ??
    readNestedNumericField(record, "data", "context_length") ??
    readNestedNumericField(record, "data", "context_window")
  )
}

function readNestedNumericField(
  record: Record<string, unknown>,
  parentKey: string,
  childKey: string,
) {
  const value = record[parentKey]
  if (!value || typeof value !== "object") {
    return null
  }

  return readNumericField(value as Record<string, unknown>, childKey)
}

function readNumericField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}
