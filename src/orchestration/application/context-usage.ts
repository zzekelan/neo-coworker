export type ContextUsageSource = "provider" | "estimated"

export type ContextUsageSnapshot = {
  contextTokens: number
  contextWindow: number
  utilizationPercent: number
  source: ContextUsageSource | null
}

export const DEFAULT_CONTEXT_WINDOW_SIZE = 192_000

export function buildContextUsageSnapshot(input: {
  contextTokens: number
  contextWindow: number
  source: ContextUsageSource | null
}): ContextUsageSnapshot {
  const contextTokens = Math.max(0, Math.trunc(input.contextTokens))
  const contextWindow = normalizeContextWindow(input.contextWindow)
  const utilizationPercent = Math.max(
    0,
    Math.min(100, Math.round((contextTokens / contextWindow) * 100)),
  )

  return {
    contextTokens,
    contextWindow,
    utilizationPercent,
    source: input.source,
  }
}

export function buildEmptyContextUsageSnapshot(input: {
  contextWindow: number
}): ContextUsageSnapshot {
  return buildContextUsageSnapshot({
    contextTokens: 0,
    contextWindow: input.contextWindow,
    source: null,
  })
}

function normalizeContextWindow(value: number) {
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_CONTEXT_WINDOW_SIZE
  }

  return Math.trunc(value)
}
