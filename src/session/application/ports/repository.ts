export type MessageRole = "user" | "assistant" | "compaction"
export type PartKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "step_start"
  | "step_finish"
  | "error"
  | "patch"
  | "compaction_boundary"
export type RunTrigger =
  | "cli"
  | "prompt"
  | "command"
  | "shell"
  | "retry"
  | "summarize"
  | "init"
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"
export type RunTokenUsageSource = "provider" | "estimated"

export type StoredSession = {
  id: string
  directory: string
  workspaceRoot: string
  createdAt: number
  currentAgent?: string
  title: string
  updatedAt: number
  latestUserMessagePreview: string | null
  activeSkills: string[]
  parentSessionId?: string
}

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

export type StoredMessage = {
  id: string
  sessionId: string
  runId: string
  agent?: string
  role: MessageRole
  sequence: number
  createdAt: number
}

export type StoredPart = {
  id: string
  sessionId: string
  runId: string
  messageId: string
  kind: PartKind
  sequence: number
  text: string | null
  data: unknown
  createdAt: number
}

export type TimelineMessage = StoredMessage & {
  parts: StoredPart[]
}

export type TimelinePart = Omit<StoredPart, "runId" | "messageId"> & {
  entryId: string
  producedByRunId: string
}

export type TimelineEntry = Omit<StoredMessage, "runId" | "sequence"> & {
  producedByRunId: string
  runSequence: number
  timelineSequence: number
  parts: TimelinePart[]
}

type EntityType = "session" | "run" | "message" | "part"

export type CreateSessionInput = {
  id?: string
  directory: string
  workspaceRoot: string
  createdAt?: number
  title?: string
  updatedAt?: number
  latestUserMessagePreview?: string | null
  activeSkills?: string[]
  parentSessionId?: string
}

export type CreateSubSessionInput = CreateSessionInput & {
  parentSessionId: string
}

export type UpdateSessionInput = {
  sessionId: string
  title?: string
  updatedAt?: number
  latestUserMessagePreview?: string | null
  activeSkills?: string[]
}

export type CreateRunInput = {
  id?: string
  sessionId: string
  trigger: RunTrigger
  status?: RunStatus
  createdAt?: number
  startedAt?: number | null
  finishedAt?: number | null
  errorText?: string | null
  activeSkills?: string[]
  inputTokens?: number
  outputTokens?: number
  tokenUsageSource?: RunTokenUsageSource | null
  parentRunId?: string | null
}

export type UpdateRunStatusInput = {
  runId: string
  status: RunStatus
  startedAt?: number | null
  finishedAt?: number | null
  errorText?: string | null
}

export type UpdateRunActiveSkillsInput = {
  runId: string
  activeSkills: string[]
}

export type UpdateRunTokenUsageInput = {
  runId: string
  inputTokens: number
  outputTokens: number
  tokenUsageSource: RunTokenUsageSource | null
}

export type CreateMessageInput = {
  id?: string
  sessionId: string
  runId: string
  agent?: string
  role: MessageRole
  sequence: number
  createdAt?: number
}

export type CreatePartInput = {
  id?: string
  sessionId: string
  runId: string
  messageId: string
  kind: PartKind
  sequence: number
  text?: string | null
  data?: unknown
  createdAt?: number
}

export type AppendTimelineEntryInput = {
  id?: string
  sessionId: string
  producedByRunId: string
  agent?: string
  role: MessageRole
  runSequence: number
  createdAt?: number
}

export type AppendTimelinePartInput = {
  id?: string
  sessionId: string
  producedByRunId: string
  entryId: string
  kind: PartKind
  sequence: number
  text?: string | null
  data?: unknown
  createdAt?: number
}

export type UpdatePartContentInput = {
  partId: string
  text?: string | null
  data?: unknown
}

export type CreateQueuedRunWithInitiatingMessageInput = {
  run: Omit<CreateRunInput, "status">
  message: {
    id?: string
    agent?: string
    sequence?: number
    createdAt?: number
  }
  allowConcurrentActiveRun?: boolean
}

export type CreateQueuedRunInput = {
  run: Omit<CreateRunInput, "status">
  allowConcurrentActiveRun?: boolean
}

export type CreateQueuedRunWithInitiatingMessageAndPartInput =
  CreateQueuedRunWithInitiatingMessageInput & {
    part: Omit<CreatePartInput, "sessionId" | "runId" | "messageId">
  }

export type CreateAssistantMessageWithFirstPartInput = {
  message: Omit<CreateMessageInput, "role">
  part: Omit<CreatePartInput, "sessionId" | "runId" | "messageId">
}

export type CreateSubSessionWithRunInput = {
  session: CreateSubSessionInput
  run: Omit<CreateRunInput, "sessionId">
  message: {
    id?: string
    agent?: string
    sequence?: number
    createdAt?: number
  }
  part: Omit<CreatePartInput, "sessionId" | "runId" | "messageId">
}

export class SessionRepositoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionRepositoryError"
  }
}

export class SessionNotFoundError extends SessionRepositoryError {
  readonly entityType: EntityType
  readonly entityId: string

  constructor(entityType: EntityType, entityId: string) {
    super(`Unknown ${entityType}: ${entityId}`)
    this.name = "SessionNotFoundError"
    this.entityType = entityType
    this.entityId = entityId
  }
}

export class SessionOwnershipError extends SessionRepositoryError {
  constructor(message: string) {
    super(message)
    this.name = "SessionOwnershipError"
  }
}

export class SessionConflictError extends SessionRepositoryError {
  constructor(message: string) {
    super(message)
    this.name = "SessionConflictError"
  }
}

export type SessionRepository = {
  storageIdentity: string
  sessions: {
    create(session: CreateSessionInput): StoredSession
    list(): StoredSession[]
    listTopLevel(): StoredSession[]
    listSubSessions(parentSessionId: string): StoredSession[]
    get(sessionId: string): StoredSession
    getCurrentAgent(sessionId: string): string | undefined
    setCurrentAgent(sessionId: string, agent: string): StoredSession
    update(session: UpdateSessionInput): StoredSession
  }
  runs: {
    create(run: CreateRunInput): StoredRun
    get(runId: string): StoredRun
    listBySession(sessionId: string): StoredRun[]
    getLatestBySession(sessionId: string): StoredRun | null
    getActiveBySession(sessionId: string): StoredRun | null
    updateStatus(update: UpdateRunStatusInput): StoredRun
    addActiveSkills(update: UpdateRunActiveSkillsInput): StoredRun
    updateTokenUsage(update: UpdateRunTokenUsageInput): StoredRun
  }
  messages: {
    create(message: CreateMessageInput): StoredMessage
    get(messageId: string): StoredMessage
    listSessionTimeline(sessionId: string): TimelineMessage[]
  }
  timeline: {
    appendEntry(input: AppendTimelineEntryInput): TimelineEntry
    appendPart(input: AppendTimelinePartInput): TimelinePart
    listEntries(sessionId: string): TimelineEntry[]
  }
  parts: {
    create(part: CreatePartInput): StoredPart
    get(partId: string): StoredPart
    updateContent(update: UpdatePartContentInput): StoredPart
  }
  createQueuedRun(input: CreateQueuedRunInput): { run: StoredRun }
  createQueuedRunWithInitiatingMessage(
    input: CreateQueuedRunWithInitiatingMessageInput,
  ): { run: StoredRun; message: StoredMessage }
  createQueuedRunWithInitiatingMessageAndPart(
    input: CreateQueuedRunWithInitiatingMessageAndPartInput,
  ): { run: StoredRun; message: StoredMessage; part: StoredPart }
  createAssistantMessageWithFirstPart(
    input: CreateAssistantMessageWithFirstPartInput,
  ): { message: StoredMessage; part: StoredPart }
  createSubSessionWithRun(input: CreateSubSessionWithRunInput): {
    session: StoredSession
    run: StoredRun
  }
}
