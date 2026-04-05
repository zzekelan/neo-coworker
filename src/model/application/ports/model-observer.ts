export type ModelObserverEvent = {
  type: "model.turn.requested"
  sessionId: string
  runId: string
  turnKey?: string
} | {
  type: "model.prompt.assembled"
  sessionId: string
  runId: string
  turnKey: string
  catalogSkillNames: string[]
  activeSkillNames: string[]
  activeSkillCount: number
  activeSkillSectionHash: string
  activeSkillSectionLength: number
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
