export const MODEL_TOKEN_USAGE_SOURCES = ["provider", "estimated"] as const

export type ModelTokenUsageSource = (typeof MODEL_TOKEN_USAGE_SOURCES)[number]

export type ModelUsageEvent = {
  type: "usage"
  inputTokens: number
  outputTokens: number
  source: ModelTokenUsageSource
}
