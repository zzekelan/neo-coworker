import OpenAI from "openai"
import {
  createOpenAICompatibleModelProvider,
  createOpenAIModelProvider,
  type ModelObserverPort,
  type ModelProvider,
} from "../model"
import { readEnvWithFallback } from "./env"

type ProviderKind = "openai" | "openai-compatible"

type ProviderConfig = {
  provider: ProviderKind
  apiKey: string
  model: string
  baseURL?: string
  timeout?: number
}

type ContextWindowMetadata = {
  contextWindow: number
  source: "provider" | "env" | "default"
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
  createClient?: (config: OpenAIClientConfig) => OpenAI
  createOpenAIProviderImpl?: ModelProviderFactory
  createOpenAICompatibleProviderImpl?: ModelProviderFactory
}

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
  const apiKey = readEnvValue(env, "LLM_API_KEY")

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

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_CONTEXT_WINDOW_SIZE = 128_000

export async function resolveContextWindowSize(input: {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
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
  let metadata: number | null = null

  try {
    metadata = await fetchContextWindowMetadata({
      config,
      fetchImpl,
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

  return {
    contextWindow: DEFAULT_CONTEXT_WINDOW_SIZE,
    source: "default",
  }
}

export async function createDefaultProvider(
  input: DefaultProviderInput = {},
): Promise<ModelProvider> {
  const config = resolveDefaultProviderConfig(input.env)
  const createClient =
    input.createClient ??
    ((clientConfig: OpenAIClientConfig) =>
      new OpenAI({
        apiKey: clientConfig.apiKey,
        baseURL: clientConfig.baseURL,
        timeout: clientConfig.timeout,
      }))
  const client = createClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeout,
  })

  if (config.provider === "openai-compatible") {
    const createProvider =
      input.createOpenAICompatibleProviderImpl ?? createOpenAICompatibleModelProvider

    return createProvider({
      model: config.model,
      client,
      observer: input.modelObserver,
    })
  }

  const createProvider = input.createOpenAIProviderImpl ?? createOpenAIModelProvider

  return createProvider({
    model: config.model,
    client,
    observer: input.modelObserver,
  })
}

async function fetchContextWindowMetadata(input: {
  config: ProviderConfig
  fetchImpl: typeof fetch
}) {
  const baseURL = input.config.baseURL ?? DEFAULT_OPENAI_BASE_URL
  const requestUrl = new URL(
    `models/${encodeURIComponent(input.config.model)}`,
    ensureTrailingSlash(baseURL),
  )
  const response = await input.fetchImpl(requestUrl, {
    headers: {
      Authorization: `Bearer ${input.config.apiKey}`,
      Accept: "application/json",
    },
  })

  if (!response.ok) {
    return null
  }

  const payload = await response.json()
  return readContextWindowFromPayload(payload)
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`
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
