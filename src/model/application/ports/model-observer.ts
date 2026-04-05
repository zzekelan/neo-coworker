export type ModelObserverEvent = {
  type: "model.turn.requested"
  sessionId: string
  runId: string
  turnKey?: string
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
}

export type ModelObserverPort = {
  recordModelEvent?(event: ModelObserverEvent): void
}
