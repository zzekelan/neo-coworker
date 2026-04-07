import type { ZodTypeAny } from "zod"

export type AgentToolCatalogEntry = {
  name: string
  description: string
  inputSchema?: ZodTypeAny
  concurrency?: "read-only" | "mutating"
  isConcurrencySafe?: (input: unknown) => boolean
}

export type AgentToolDefinition = AgentToolCatalogEntry & {
  execute(input: AgentToolExecutionInput): Promise<AgentToolExecutionResult> | AgentToolExecutionResult
  usageGuidance?: string
  resultSizeLimit?: number
  isCompressible?: boolean
  timeout?: number
}

export type AgentToolExecutionInput = {
  toolName: string
  args: unknown
  workspaceRoot: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export type AgentToolExecutionResult = {
  output: string
  isError?: boolean
  metadata?: Record<string, unknown>
}

export type AgentToolBatchCall = {
  callId: string
  toolName: string
  args: unknown
  onProgress?: (message: string) => void
}

export type AgentToolBatchResult = {
  callId: string
  toolName: string
  output: string
  isError?: boolean
  metadata?: Record<string, unknown>
}

export type AgentToolPort = {
  list(): AgentToolCatalogEntry[]
  execute(input: AgentToolExecutionInput): Promise<AgentToolExecutionResult> | AgentToolExecutionResult
  executeBatch(input: {
    calls: AgentToolBatchCall[]
    workspaceRoot: string
    signal: AbortSignal
  }): Promise<AgentToolBatchResult[]>
}

export type AgentToolRuntime = {
  list(): AgentToolCatalogEntry[]
  execute(input: AgentToolExecutionInput): Promise<AgentToolExecutionResult>
}

export type AgentToolProvider = Pick<AgentToolRuntime, "list" | "execute">

export type AgentToolBatchExecutor = {
  execute(input: {
    calls: AgentToolBatchCall[]
    tools: AgentToolProvider
    availableTools: AgentToolCatalogEntry[]
    workspaceRoot: string
    signal: AbortSignal
  }): Promise<AgentToolBatchResult[]>
}

export type CreateAgentToolRuntime = (input: {
  tools: AgentToolDefinition[]
}) => AgentToolRuntime

export type CreateAgentToolProvider = (input: {
  runtime: AgentToolRuntime
}) => AgentToolProvider

export type CreateAgentToolBatchExecutor = () => AgentToolBatchExecutor

export type AgentSkillCatalogEntry = {
  name: string
  description: string
  path: string
}

export type AgentLoadedSkill = {
  name: string
  instructions: string
  path: string
}

export type AgentSkillPort = {
  listCatalog(workspaceRoot: string): Promise<AgentSkillCatalogEntry[]>
  loadSkill(input: {
    workspaceRoot: string
    name: string
  }): Promise<AgentLoadedSkill>
}

export type AgentContextWindowPort = {
  getContextWindow(): number
}

export type AgentRuntimeObserverPort = {
  recordRuntimeEvent?(input: {
    sessionId: string
    runId: string
    event: AgentRuntimeEvent
    occurredAt?: number
  }): void
}

export type AgentRuntimeEvent = {
  type: string
  [key: string]: unknown
}

export type AgentSessionRecord = {
  id: string
  workspaceRoot: string
  activeSkills: string[]
}

export type AgentRunRecord = {
  id: string
  sessionId: string
  createdAt: number
  status: "queued" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled"
  activeSkills: string[]
  inputTokens: number
  outputTokens: number
  tokenUsageSource: "provider" | "estimated" | null
}

export type AgentTranscriptPart = {
  kind: string
  text: string | null
  data?: unknown
}

export type AgentTranscriptMessage = {
  runId: string
  role: "user" | "assistant" | "system" | "synthetic"
  sequence: number
  parts: AgentTranscriptPart[]
}

export type AgentMessageRecord = {
  id: string
}

export type AgentPartRecord = {
  id: string
  kind: string
  text: string | null
  data?: unknown
}

export type AgentSessionPort = {
  storageIdentity: string
  getSession(sessionId: string): AgentSessionRecord
  getRun(runId: string): AgentRunRecord
  listTranscript(sessionId: string): AgentTranscriptMessage[]
  createRun(input: {
    id: string
    sessionId: string
    trigger: "summarize"
    status: AgentRunRecord["status"]
    createdAt: number
    startedAt?: number | null
    finishedAt?: number | null
    errorText?: string | null
    activeSkills?: string[]
    inputTokens?: number
    outputTokens?: number
    tokenUsageSource?: "provider" | "estimated" | null
  }): AgentRunRecord
  createAssistantMessage(input: {
    sessionId: string
    runId: string
    sequence: number
    createdAt: number
  }): AgentMessageRecord
  createSyntheticMessage(input: {
    sessionId: string
    runId: string
    sequence: number
    createdAt: number
  }): AgentMessageRecord
  createMessagePart(input: {
    sessionId: string
    runId: string
    messageId: string
    kind: string
    sequence: number
    text?: string | null
    data?: unknown
    createdAt: number
  }): AgentPartRecord
  updateMessagePart(input: {
    partId: string
    text?: string | null
    data?: unknown
  }): AgentPartRecord
  recordRunTokenUsage(input: {
    runId: string
    inputTokens: number
    outputTokens: number
    tokenUsageSource: "provider" | "estimated"
  }): AgentRunRecord
  transitionRunToRunning(runId: string): AgentRunRecord
  completeRun(runId: string): AgentRunRecord
  failRun(input: {
    runId: string
    errorText?: string | null
  }): AgentRunRecord
  cancelRun(runId: string): AgentRunRecord
}

export type AgentModelPort = {
  projectTurn?(request: Omit<AgentModelTurnRequest, "signal">): {
    inputTokens: number
  }
  streamTurn(request: AgentModelTurnRequest): AsyncIterable<AgentModelEvent>
}

export type AgentModelTurnRequest = {
  systemPrompt: string
  lateContextMessage?: string
  skillCatalog: AgentSkillCatalogEntry[]
  activeSkills: Array<{ name: string; instructions: string }>
  systemReminders?: string[]
  systemReminderMetadata?: {
    catalogSkillNames: string[]
    activeSkillNames: string[]
    recoveryFilePaths: string[]
  }
  contextWindow?: number
  tools: Array<Pick<AgentToolDefinition, "name" | "description" | "inputSchema" | "concurrency" | "isConcurrencySafe">>
  transcript: AgentTranscriptMessage[]
  compressibleToolNames?: ReadonlySet<string>
  sessionId?: string
  runId?: string
  turnKey?: string
  signal: AbortSignal
}

export type AgentModelEvent =
  | {
      type: "text.delta"
      text: string
    }
  | {
      type: "tool.call"
      callId: string
      name: string
      inputText: string
    }
  | {
      type: "usage"
      inputTokens: number
      outputTokens: number
      source: "provider" | "estimated"
    }

export type AgentStepService = {
  isAbortError(error: unknown, signal: AbortSignal): boolean
  isDetachedError(error: unknown): boolean
  initializeRun(input: {
    sessionId: string
    runId: string
    emit: (event: AgentRuntimeEvent) => void
  }): void
  completeRun(input: {
    runId: string
    emit: (event: AgentRuntimeEvent) => void
  }): void
  failRun(input: {
    runId: string
    error: string
    emit: (event: AgentRuntimeEvent) => void
  }): void
  cancelRun(input: {
    runId: string
    emit?: (event: AgentRuntimeEvent) => void
  }): boolean
  executeStep(input: {
    sessionId: string
    runId: string
    tools: AgentToolPort
    workspaceRoot: string
    systemPrompt: string
    signal: AbortSignal
    emit: (event: AgentRuntimeEvent) => void
  }): Promise<
    | { status: "repeat" | "complete" | "cancelled" }
    | { status: "failed"; error: string }
  >
}

export type CreateAgentStepService = (input: {
  session: AgentSessionPort
  model: AgentModelPort
  contextWindow: AgentContextWindowPort
  skill: AgentSkillPort
  runtimeObserver?: AgentRuntimeObserverPort
  now?: () => number
}) => AgentStepService
