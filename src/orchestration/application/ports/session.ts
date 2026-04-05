export type OrchestrationMessageRole = "user" | "assistant" | "system" | "synthetic"

export type OrchestrationRunStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"

export type OrchestrationTranscriptPart = {
  kind: string
  text: string | null
  data?: unknown
}

export type OrchestrationTranscriptMessage = {
  runId: string
  role: OrchestrationMessageRole
  sequence: number
  parts: OrchestrationTranscriptPart[]
}

export type OrchestrationSessionRecord = {
  id: string
  workspaceRoot: string
  activeSkills: string[]
}

export type OrchestrationRunRecord = {
  id: string
  sessionId: string
  createdAt: number
  status: OrchestrationRunStatus
  activeSkills: string[]
  inputTokens: number
  outputTokens: number
  tokenUsageSource: "provider" | "estimated" | null
}

export type OrchestrationMessageRecord = {
  id: string
}

export type OrchestrationPartRecord = {
  id: string
  kind: string
  text: string | null
  data?: unknown
}

export type OrchestrationSessionPort = {
  storageIdentity: string
  getSession(sessionId: string): OrchestrationSessionRecord
  getRun(runId: string): OrchestrationRunRecord
  listTranscript(sessionId: string): OrchestrationTranscriptMessage[]
  createRun(input: {
    id: string
    sessionId: string
    trigger: "summarize"
    status: OrchestrationRunStatus
    createdAt: number
    startedAt?: number | null
    finishedAt?: number | null
    errorText?: string | null
    activeSkills?: string[]
    inputTokens?: number
    outputTokens?: number
    tokenUsageSource?: "provider" | "estimated" | null
  }): OrchestrationRunRecord
  createAssistantMessage(input: {
    sessionId: string
    runId: string
    sequence: number
    createdAt: number
  }): OrchestrationMessageRecord
  createSyntheticMessage(input: {
    sessionId: string
    runId: string
    sequence: number
    createdAt: number
  }): OrchestrationMessageRecord
  createMessagePart(input: {
    sessionId: string
    runId: string
    messageId: string
    kind: string
    sequence: number
    text?: string | null
    data?: unknown
    createdAt: number
  }): OrchestrationPartRecord
  updateMessagePart(input: {
    partId: string
    text?: string | null
    data?: unknown
  }): OrchestrationPartRecord
  recordRunTokenUsage(input: {
    runId: string
    inputTokens: number
    outputTokens: number
    tokenUsageSource: "provider" | "estimated"
  }): OrchestrationRunRecord
  transitionRunToRunning(runId: string): OrchestrationRunRecord
  completeRun(runId: string): OrchestrationRunRecord
  failRun(input: {
    runId: string
    errorText?: string | null
  }): OrchestrationRunRecord
  cancelRun(runId: string): OrchestrationRunRecord
}
