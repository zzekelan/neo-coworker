import type {
  MessageRole,
  PartKind,
  PermissionStatus,
  RunStatus,
  RunTrigger,
  StoredMessage,
  StoredPart,
  StoredRun,
  StoredSession,
  TranscriptMessage,
} from "../config/defaults"

export type {
  MessageRole,
  PartKind,
  PermissionStatus,
  RunStatus,
  RunTrigger,
  StoredMessage,
  StoredPart,
  StoredRun,
  StoredSession,
  TranscriptMessage,
} from "../config/defaults"

type EntityType = "session" | "run" | "message" | "part" | "permission_request"

export type StoredPermissionRequest = {
  id: string
  sessionId: string
  runId: string
  toolName: string
  reason: string
  status: PermissionStatus
  createdAt: number
  resolvedAt: number | null
}

export type CreateSessionInput = {
  id?: string
  directory: string
  workspaceRoot: string
  createdAt?: number
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
}

export type UpdateRunStatusInput = {
  runId: string
  status: RunStatus
  startedAt?: number | null
  finishedAt?: number | null
  errorText?: string | null
}

export type CreateMessageInput = {
  id?: string
  sessionId: string
  runId: string
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

export type UpdatePartContentInput = {
  partId: string
  text?: string | null
  data?: unknown
}

export type CreatePermissionRequestInput = {
  id?: string
  sessionId: string
  runId: string
  toolName: string
  reason: string
  status?: PermissionStatus
  createdAt?: number
  resolvedAt?: number | null
}

export type UpdatePermissionRequestStatusInput = {
  requestId: string
  status: PermissionStatus
  resolvedAt?: number | null
}

export type CreateQueuedRunWithInitiatingMessageInput = {
  run: Omit<CreateRunInput, "status">
  message: {
    id?: string
    sequence?: number
    createdAt?: number
  }
}

export type CreateAssistantMessageWithFirstPartInput = {
  message: Omit<CreateMessageInput, "role">
  part: Omit<CreatePartInput, "sessionId" | "runId" | "messageId">
}

export type RequestPermissionAndPauseRunInput = {
  runId: string
  permissionRequest: Pick<CreatePermissionRequestInput, "id" | "toolName" | "reason" | "createdAt">
}

export type CancelRunAndPendingPermissionsInput = {
  runId: string
  finishedAt?: number
  resolvedAt?: number
}

export class ConversationRepositoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConversationRepositoryError"
  }
}

export class ConversationNotFoundError extends ConversationRepositoryError {
  readonly entityType: EntityType
  readonly entityId: string

  constructor(entityType: EntityType, entityId: string) {
    super(`Unknown ${entityType}: ${entityId}`)
    this.name = "ConversationNotFoundError"
    this.entityType = entityType
    this.entityId = entityId
  }
}

export class ConversationOwnershipError extends ConversationRepositoryError {
  constructor(message: string) {
    super(message)
    this.name = "ConversationOwnershipError"
  }
}

export class ConversationConflictError extends ConversationRepositoryError {
  constructor(message: string) {
    super(message)
    this.name = "ConversationConflictError"
  }
}

export type ConversationRepository = {
  storageIdentity: string
  sessions: {
    create(session: CreateSessionInput): StoredSession
    list(): StoredSession[]
    get(sessionId: string): StoredSession
  }
  runs: {
    create(run: CreateRunInput): StoredRun
    get(runId: string): StoredRun
    listBySession(sessionId: string): StoredRun[]
    getLatestBySession(sessionId: string): StoredRun | null
    getActiveBySession(sessionId: string): StoredRun | null
    updateStatus(update: UpdateRunStatusInput): StoredRun
  }
  messages: {
    create(message: CreateMessageInput): StoredMessage
    get(messageId: string): StoredMessage
    listSessionTranscript(sessionId: string): TranscriptMessage[]
  }
  parts: {
    create(part: CreatePartInput): StoredPart
    get(partId: string): StoredPart
    updateContent(update: UpdatePartContentInput): StoredPart
  }
  permissionRequests: {
    create(request: CreatePermissionRequestInput): StoredPermissionRequest
    get(requestId: string): StoredPermissionRequest
    listByRun(runId: string): StoredPermissionRequest[]
    updateStatus(update: UpdatePermissionRequestStatusInput): StoredPermissionRequest
  }
  createQueuedRunWithInitiatingMessage(
    input: CreateQueuedRunWithInitiatingMessageInput,
  ): { run: StoredRun; message: StoredMessage }
  createAssistantMessageWithFirstPart(
    input: CreateAssistantMessageWithFirstPartInput,
  ): { message: StoredMessage; part: StoredPart }
  requestPermissionAndPauseRun(
    input: RequestPermissionAndPauseRunInput,
  ): { run: StoredRun; permissionRequest: StoredPermissionRequest }
  cancelRunAndPendingPermissions(
    input: CancelRunAndPendingPermissionsInput,
  ): { run: StoredRun; permissionRequests: StoredPermissionRequest[] }
}
