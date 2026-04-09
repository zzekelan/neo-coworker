export const RUN_TRIGGERS = [
  "cli",
  "prompt",
  "command",
  "shell",
  "retry",
  "summarize",
  "init",
] as const

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
] as const

export type RunTrigger = (typeof RUN_TRIGGERS)[number]
export type RunStatus = (typeof RUN_STATUSES)[number]
export const RUN_ACTIVE_SKILLS_MAX_LENGTH = 100
export const RUN_TOKEN_USAGE_SOURCES = ["provider", "estimated"] as const

export type RunTokenUsageSource = (typeof RUN_TOKEN_USAGE_SOURCES)[number]

export type StoredRun = {
  id: string
  sessionId: string
  trigger: RunTrigger
  status: RunStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  errorText: string | null
  activeSkills: string[]
  inputTokens: number
  outputTokens: number
  tokenUsageSource: RunTokenUsageSource | null
  parentRunId: string | null
}

export function normalizeRunActiveSkills(activeSkills: readonly string[] | null | undefined) {
  if (!activeSkills || activeSkills.length === 0) {
    return []
  }

  const seen = new Set<string>()
  const normalized: string[] = []

  for (const activeSkill of activeSkills) {
    const value = activeSkill.trim()

    if (!value || seen.has(value)) {
      continue
    }

    seen.add(value)
    normalized.push(value)

    if (normalized.length >= RUN_ACTIVE_SKILLS_MAX_LENGTH) {
      break
    }
  }

  return normalized
}
