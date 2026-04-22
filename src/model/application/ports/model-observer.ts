type ModelFailoverReason =
  | "auth"
  | "billing"
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "context_overflow"
  | "model_not_found"
  | "unknown"

export type ModelObserverEvent = {
  type: "model.turn.requested"
  sessionId: string
  runId: string
  turnKey?: string
} | {
  type: "replay.fail_fast.blocked"
  sessionId: string
  runId: string
  turnKey: string
  model: string
  providerFamily: "kimi"
  classification: "legacy_session_missing_reasoning"
  missingPart: "reasoning"
  requiredReasoningField: "reasoning_content" | "reasoning_details"
} | {
  type: "microcompact.applied"
  sessionId: string
  runId: string
  turnKey: string
  clearedCount: number
  retainedCount: number
  estimatedTokensSaved: number
} | {
  type: "model.prompt.assembled"
  sessionId: string
  runId: string
  turnKey: string
  catalogSkillNames: string[]
  activeSkillNames: string[]
  activeSkillCount: number
  recoveryFilePaths: string[]
  systemPromptHash: string
  systemPromptLength: number
  systemReminderHash: string | null
  systemReminderLength: number | null
} | {
  type: "model.turn.usage"
  sessionId: string
  runId: string
  turnKey: string
  inputTokens: number
  outputTokens: number
  tokenUsageSource: "provider" | "estimated"
} | {
  type: "error.classified"
  sessionId: string
  runId: string
  turnKey: string
  errorType: ModelFailoverReason
  severity: "warning" | "error"
  shouldRetry: boolean
  shouldRotateCredential: boolean
  shouldFallback: boolean
} | {
  type: "credential.rotated"
  sessionId: string
  runId: string
  turnKey?: string
  failedKey: string
  nextKey: string | null
  reason: ModelFailoverReason
  remainingCredentials: number
} | {
  type: "rate_limit.near_threshold"
  sessionId: string
  runId: string
  turnKey?: string
  rpm_remaining?: number
  tpm_remaining?: number
  threshold: number
}

export type ModelObserverPort = {
  recordModelEvent?(event: ModelObserverEvent): void
}
