type ProviderKind = "openai" | "openai-compatible"

export type InterleavedReasoningField = "reasoning_content" | "reasoning_details"
export type CapabilitySource = "override" | "models.dev" | "default"

export type ProviderCapabilityResolverConfig = {
  provider: ProviderKind
  model: string
  baseURL?: string
}

export type ProviderCapabilityOverride = {
  thinking?: boolean
  reasoningEffort?: boolean
}

export type ModelsDevModeMetadata = {
  provider?: {
    body?: Record<string, unknown>
  }
}

export type ModelsDevModelMetadata = {
  id: string
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  interleaved?: true | { field: InterleavedReasoningField }
  experimental?: {
    modes?: Record<string, ModelsDevModeMetadata>
  }
}

export type ModelsDevProviderMetadata = {
  id: string
  name: string
  models: Record<string, ModelsDevModelMetadata>
}

export type ModelsDevCatalog = Record<string, ModelsDevProviderMetadata>

export type ResolvedCapabilityFlag = {
  supported: boolean
  source: CapabilitySource
}

export type ResolvedProviderCapabilities = {
  provider: ProviderKind
  providerId: string | null
  model: string
  catalog: {
    source: "models.dev" | "default"
    miss: boolean
  }
  reasoning: ResolvedCapabilityFlag
  toolCall: ResolvedCapabilityFlag
  interleaved: {
    supported: boolean
    field: InterleavedReasoningField | null
    source: CapabilitySource
  }
  reasoningEffort: ResolvedCapabilityFlag
  thinkingControls: {
    thinking: ResolvedCapabilityFlag
    reasoningEffort: ResolvedCapabilityFlag
  }
}

const DEFAULT_CAPABILITIES = {
  reasoning: false,
  toolCall: true,
  interleaved: {
    supported: false,
    field: null,
  } satisfies Pick<ResolvedProviderCapabilities["interleaved"], "supported" | "field">,
  reasoningEffort: false,
  thinkingControl: false,
  reasoningEffortControl: false,
} as const

export const DEFAULT_MODELS_DEV_CAPABILITY_CATALOG: ModelsDevCatalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        tool_call: true,
        experimental: {
          modes: {
            low: { provider: { body: { reasoning_effort: "low" } } },
            medium: { provider: { body: { reasoning_effort: "medium" } } },
            high: { provider: { body: { reasoning_effort: "high" } } },
          },
        },
      },
      "gpt-5-mini": {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        reasoning: true,
        tool_call: true,
        experimental: {
          modes: {
            low: { provider: { body: { reasoning_effort: "low" } } },
            medium: { provider: { body: { reasoning_effort: "medium" } } },
            high: { provider: { body: { reasoning_effort: "high" } } },
          },
        },
      },
    },
  },
  moonshotai: {
    id: "moonshotai",
    name: "Moonshot AI",
    models: {
      "kimi-k2.5": {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        reasoning: true,
        tool_call: true,
        interleaved: { field: "reasoning_content" },
        experimental: {
          modes: {
            low: {
              provider: {
                body: { reasoning_effort: "low", thinking: { keep: "all" } },
              },
            },
            medium: {
              provider: {
                body: { reasoning_effort: "medium", thinking: { keep: "all" } },
              },
            },
            high: {
              provider: {
                body: { reasoning_effort: "high", thinking: { keep: "all" } },
              },
            },
          },
        },
      },
      "kimi-k2.6": {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        reasoning: true,
        tool_call: true,
        interleaved: { field: "reasoning_content" },
        experimental: {
          modes: {
            low: {
              provider: {
                body: { reasoning_effort: "low", thinking: { keep: "all" } },
              },
            },
            medium: {
              provider: {
                body: { reasoning_effort: "medium", thinking: { keep: "all" } },
              },
            },
            high: {
              provider: {
                body: { reasoning_effort: "high", thinking: { keep: "all" } },
              },
            },
          },
        },
      },
    },
  },
}

const BASE_URL_PROVIDER_ALIASES = new Map<string, string>([["moonshot", "moonshotai"]])
const MODEL_PREFIX_PROVIDER_ALIASES = new Map<string, string>([["kimi-", "moonshotai"]])
const THINKING_CONTROL_KEYS = [
  "thinking",
  "enable_thinking",
  "thinkingConfig",
  "thinking_budget",
  "thinkingLevel",
]
const REASONING_EFFORT_KEYS = ["reasoning_effort", "reasoningEffort"]

export function resolveProviderCapabilities(input: {
  config: ProviderCapabilityResolverConfig
  override?: ProviderCapabilityOverride
  catalog?: ModelsDevCatalog
}): ResolvedProviderCapabilities {
  const catalog = input.catalog ?? DEFAULT_MODELS_DEV_CAPABILITY_CATALOG
  const matched = findCatalogModel(input.config, catalog)
  const modelMetadata = matched?.model ?? null
  const matchedModelsDev = modelMetadata != null

  const reasoning = modelMetadata?.reasoning ?? DEFAULT_CAPABILITIES.reasoning
  const toolCall = modelMetadata?.tool_call ?? DEFAULT_CAPABILITIES.toolCall
  const interleaved = resolveInterleavedMetadata(modelMetadata?.interleaved)
  const reasoningEffort = modelMetadata
    ? hasProviderBodyKey(modelMetadata, REASONING_EFFORT_KEYS)
    : DEFAULT_CAPABILITIES.reasoningEffort
  const thinkingControl = modelMetadata
    ? reasoning || hasProviderBodyKey(modelMetadata, THINKING_CONTROL_KEYS)
    : DEFAULT_CAPABILITIES.thinkingControl
  const reasoningEffortControl = modelMetadata
    ? reasoningEffort
    : DEFAULT_CAPABILITIES.reasoningEffortControl

  return {
    provider: input.config.provider,
    providerId: matched?.providerId ?? null,
    model: input.config.model,
    catalog: {
      source: matchedModelsDev ? "models.dev" : "default",
      miss: !matchedModelsDev,
    },
    reasoning: resolveCatalogFlag(reasoning, matchedModelsDev),
    toolCall: resolveCatalogFlag(toolCall, matchedModelsDev),
    interleaved: {
      ...interleaved,
      source: matchedModelsDev ? "models.dev" : "default",
    },
    reasoningEffort: resolveCatalogFlag(reasoningEffort, matchedModelsDev),
    thinkingControls: {
      thinking: resolveOverrideFlag({
        supported: thinkingControl,
        matchedModelsDev,
        override: input.override?.thinking,
      }),
      reasoningEffort: resolveOverrideFlag({
        supported: reasoningEffortControl,
        matchedModelsDev,
        override: input.override?.reasoningEffort,
      }),
    },
  }
}

function resolveCatalogFlag(
  supported: boolean,
  matchedModelsDev: boolean,
): ResolvedCapabilityFlag {
  return {
    supported,
    source: matchedModelsDev ? "models.dev" : "default",
  }
}

function resolveOverrideFlag(input: {
  supported: boolean
  matchedModelsDev: boolean
  override?: boolean
}): ResolvedCapabilityFlag {
  if (input.override != null) {
    return {
      supported: input.override,
      source: "override",
    }
  }

  return resolveCatalogFlag(input.supported, input.matchedModelsDev)
}

function findCatalogModel(config: ProviderCapabilityResolverConfig, catalog: ModelsDevCatalog) {
  const providerIds = buildProviderCandidates(config, catalog)

  for (const providerId of providerIds) {
    const provider = catalog[providerId]
    const model = provider?.models[config.model]
    if (model) {
      return {
        providerId,
        model,
      }
    }
  }

  const matches = Object.values(catalog)
    .filter((provider) => provider.models[config.model])
    .map((provider) => ({
      providerId: provider.id,
      model: provider.models[config.model] as ModelsDevModelMetadata,
    }))

  return matches.length === 1 ? matches[0] : null
}

function buildProviderCandidates(
  config: ProviderCapabilityResolverConfig,
  catalog: ModelsDevCatalog,
) {
  const candidates: string[] = []

  if (config.provider === "openai") {
    candidates.push("openai")
  }

  const host = readBaseUrlHost(config.baseURL)
  if (host) {
    for (const [needle, providerId] of BASE_URL_PROVIDER_ALIASES) {
      if (host.includes(needle)) {
        candidates.push(providerId)
      }
    }
  }

  const lowerModel = config.model.toLowerCase()
  for (const [prefix, providerId] of MODEL_PREFIX_PROVIDER_ALIASES) {
    if (lowerModel.startsWith(prefix)) {
      candidates.push(providerId)
    }
  }

  if (candidates.length === 0 && config.provider === "openai-compatible") {
    for (const provider of Object.values(catalog)) {
      if (provider.models[config.model]) {
        candidates.push(provider.id)
      }
    }
  }

  return [...new Set(candidates)]
}

function readBaseUrlHost(baseURL: string | undefined) {
  if (!baseURL) {
    return null
  }

  try {
    return new URL(baseURL).host.toLowerCase()
  } catch {
    return null
  }
}

function resolveInterleavedMetadata(
  input: ModelsDevModelMetadata["interleaved"] | undefined,
): Pick<ResolvedProviderCapabilities["interleaved"], "supported" | "field"> {
  if (input === true) {
    return {
      supported: true,
      field: null,
    }
  }

  if (input && typeof input === "object" && typeof input.field === "string") {
    return {
      supported: true,
      field: input.field,
    }
  }

  return {
    supported: DEFAULT_CAPABILITIES.interleaved.supported,
    field: DEFAULT_CAPABILITIES.interleaved.field,
  }
}

function hasProviderBodyKey(model: ModelsDevModelMetadata, keys: string[]) {
  for (const mode of Object.values(model.experimental?.modes ?? {})) {
    const body = mode.provider?.body
    if (!body || typeof body !== "object") {
      continue
    }

    for (const key of keys) {
      if (key in body) {
        return true
      }
    }
  }

  return false
}
