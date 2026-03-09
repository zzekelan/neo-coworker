import { getStorageDatabaseIdentity, type StorageDatabase } from "./db"
import {
  MESSAGE_ROLES,
  PART_KINDS,
  PERMISSION_STATUSES,
  RUN_TRIGGERS,
  RUN_STATUSES,
} from "./schema"

export type RunStatus = (typeof RUN_STATUSES)[number]
export type MessageRole = (typeof MESSAGE_ROLES)[number]
export type PartKind = (typeof PART_KINDS)[number]
export type PermissionStatus = (typeof PERMISSION_STATUSES)[number]
export type RunTrigger = (typeof RUN_TRIGGERS)[number]

const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_permission"] as const
const activeRunStatusCheck = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ")

type EntityType = "session" | "run" | "message" | "part" | "permission_request"
type IdPrefix = "session" | "run" | "message" | "part" | "permission"

type SessionRow = {
  id: string
  directory: string
  workspace_root: string
  created_at: number
}

type RunRow = {
  id: string
  session_id: string
  trigger: RunTrigger
  status: RunStatus
  created_at: number
  started_at: number | null
  finished_at: number | null
  error_text: string | null
}

type MessageRow = {
  id: string
  session_id: string
  run_id: string
  role: MessageRole
  sequence: number
  created_at: number
}

type PartRow = {
  id: string
  session_id: string
  run_id: string
  message_id: string
  kind: PartKind
  sequence: number
  text_value: string | null
  data_json: string | null
  created_at: number
}

type PermissionRequestRow = {
  id: string
  session_id: string
  run_id: string
  tool_name: string
  reason: string
  status: PermissionStatus
  created_at: number
  resolved_at: number | null
}

type TranscriptRow = {
  message_id: string
  message_session_id: string
  message_run_id: string
  message_role: MessageRole
  message_sequence: number
  message_created_at: number
  part_id: string | null
  part_session_id: string | null
  part_run_id: string | null
  part_message_id: string | null
  part_kind: PartKind | null
  part_sequence: number | null
  part_text_value: string | null
  part_data_json: string | null
  part_created_at: number | null
}

export type StoredSession = {
  id: string
  directory: string
  workspaceRoot: string
  createdAt: number
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
}

export type StoredMessage = {
  id: string
  sessionId: string
  runId: string
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

export type TranscriptMessage = StoredMessage & {
  parts: StoredPart[]
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

type CancelRunAndPendingPermissionsInput = {
  runId: string
  finishedAt?: number
  resolvedAt?: number
}

export class StorageRepositoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StorageRepositoryError"
  }
}

export class StorageNotFoundError extends StorageRepositoryError {
  readonly entityType: EntityType
  readonly entityId: string

  constructor(entityType: EntityType, entityId: string) {
    super(`Unknown ${entityType}: ${entityId}`)
    this.name = "StorageNotFoundError"
    this.entityType = entityType
    this.entityId = entityId
  }
}

export class StorageOwnershipError extends StorageRepositoryError {
  constructor(message: string) {
    super(message)
    this.name = "StorageOwnershipError"
  }
}

export class StorageConflictError extends StorageRepositoryError {
  constructor(message: string) {
    super(message)
    this.name = "StorageConflictError"
  }
}

export type StorageRepository = ReturnType<typeof createStorageRepository>

export function createStorageRepository(input: {
  database: StorageDatabase
  now?: () => number
  createId?: (prefix: IdPrefix) => string
}) {
  const database = input.database
  const storageIdentity = getStorageDatabaseIdentity(database)
  const now = input.now ?? Date.now
  const createId =
    input.createId ?? ((prefix: IdPrefix) => `${prefix}_${crypto.randomUUID()}`)

  function buildId(prefix: IdPrefix, value?: string) {
    return value ?? createId(prefix)
  }

  function getSessionRow(sessionId: string) {
    return database
      .query("SELECT id, directory, workspace_root, created_at FROM session WHERE id = ?")
      .get(sessionId) as SessionRow | null
  }

  function listSessionRows() {
    return database
      .query(
        `
          SELECT id, directory, workspace_root, created_at
          FROM session
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all() as SessionRow[]
  }

  function getRunRow(runId: string) {
    return database
      .query(
        "SELECT id, session_id, trigger, status, created_at, started_at, finished_at, error_text FROM run WHERE id = ?",
      )
      .get(runId) as RunRow | null
  }

  function listRunRowsBySession(sessionId: string) {
    return database
      .query(
        `
          SELECT id, session_id, trigger, status, created_at, started_at, finished_at, error_text
          FROM run
          WHERE session_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(sessionId) as RunRow[]
  }

  function getLatestRunRowBySession(sessionId: string) {
    return database
      .query(
        `
          SELECT id, session_id, trigger, status, created_at, started_at, finished_at, error_text
          FROM run
          WHERE session_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
      )
      .get(sessionId) as RunRow | null
  }

  function getActiveRunRowBySession(sessionId: string) {
    return database
      .query(
        `
          SELECT id, session_id, trigger, status, created_at, started_at, finished_at, error_text
          FROM run
          WHERE session_id = ? AND status IN (${activeRunStatusCheck})
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
      )
      .get(sessionId) as RunRow | null
  }

  function getMessageRow(messageId: string) {
    return database
      .query(
        "SELECT id, session_id, run_id, role, sequence, created_at FROM message WHERE id = ?",
      )
      .get(messageId) as MessageRow | null
  }

  function getPartRow(partId: string) {
    return database
      .query(
        "SELECT id, session_id, run_id, message_id, kind, sequence, text_value, data_json, created_at FROM part WHERE id = ?",
      )
      .get(partId) as PartRow | null
  }

  function getPermissionRequestRow(requestId: string) {
    return database
      .query(
        "SELECT id, session_id, run_id, tool_name, reason, status, created_at, resolved_at FROM permission_request WHERE id = ?",
      )
      .get(requestId) as PermissionRequestRow | null
  }

  function listPermissionRequestRowsByRun(runId: string) {
    return database
      .query(
        `
          SELECT id, session_id, run_id, tool_name, reason, status, created_at, resolved_at
          FROM permission_request
          WHERE run_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(runId) as PermissionRequestRow[]
  }

  function requireSession(sessionId: string) {
    const row = getSessionRow(sessionId)
    if (!row) {
      throw new StorageNotFoundError("session", sessionId)
    }
    return mapSessionRow(row)
  }

  function requireRun(runId: string) {
    const row = getRunRow(runId)
    if (!row) {
      throw new StorageNotFoundError("run", runId)
    }
    return mapRunRow(row)
  }

  function requireRunOwnership(runId: string, sessionId: string) {
    const run = requireRun(runId)
    if (run.sessionId !== sessionId) {
      throw new StorageOwnershipError(`Run ${runId} does not belong to session ${sessionId}`)
    }
    return run
  }

  function requireMessage(messageId: string) {
    const row = getMessageRow(messageId)
    if (!row) {
      throw new StorageNotFoundError("message", messageId)
    }
    return mapMessageRow(row)
  }

  function requireMessageOwnership(messageId: string, runId: string, sessionId: string) {
    const message = requireMessage(messageId)
    if (message.sessionId !== sessionId) {
      throw new StorageOwnershipError(
        `Message ${messageId} does not belong to session ${sessionId}`,
      )
    }
    if (message.runId !== runId) {
      throw new StorageOwnershipError(`Message ${messageId} does not belong to run ${runId}`)
    }
    return message
  }

  function requirePart(partId: string) {
    const row = getPartRow(partId)
    if (!row) {
      throw new StorageNotFoundError("part", partId)
    }
    return mapPartRow(row)
  }

  function requirePermissionRequest(requestId: string) {
    const row = getPermissionRequestRow(requestId)
    if (!row) {
      throw new StorageNotFoundError("permission_request", requestId)
    }
    return mapPermissionRequestRow(row)
  }

  const sessions = {
    create(session: CreateSessionInput): StoredSession {
      const record: StoredSession = {
        id: buildId("session", session.id),
        directory: session.directory,
        workspaceRoot: session.workspaceRoot,
        createdAt: session.createdAt ?? now(),
      }

      database
        .query(
          "INSERT INTO session (id, directory, workspace_root, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(record.id, record.directory, record.workspaceRoot, record.createdAt)

      return record
    },
    list() {
      return listSessionRows().map(mapSessionRow)
    },
    get(sessionId: string) {
      return requireSession(sessionId)
    },
  }

  const runs = {
    create(run: CreateRunInput): StoredRun {
      requireSession(run.sessionId)

      const record: StoredRun = {
        id: buildId("run", run.id),
        sessionId: run.sessionId,
        trigger: run.trigger,
        status: run.status ?? "queued",
        createdAt: run.createdAt ?? now(),
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
        errorText: run.errorText ?? null,
      }

      database
        .query(
          `
            INSERT INTO run (
              id,
              session_id,
              trigger,
              status,
              created_at,
              started_at,
              finished_at,
              error_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.id,
          record.sessionId,
          record.trigger,
          record.status,
          record.createdAt,
          record.startedAt,
          record.finishedAt,
          record.errorText,
        )

      return record
    },
    get(runId: string) {
      return requireRun(runId)
    },
    listBySession(sessionId: string) {
      requireSession(sessionId)
      return listRunRowsBySession(sessionId).map(mapRunRow)
    },
    getLatestBySession(sessionId: string) {
      requireSession(sessionId)
      const row = getLatestRunRowBySession(sessionId)
      return row ? mapRunRow(row) : null
    },
    getActiveBySession(sessionId: string) {
      requireSession(sessionId)
      const row = getActiveRunRowBySession(sessionId)
      return row ? mapRunRow(row) : null
    },
    updateStatus(update: UpdateRunStatusInput) {
      const current = requireRun(update.runId)
      const record: StoredRun = {
        ...current,
        status: update.status,
        startedAt: update.startedAt === undefined ? current.startedAt : update.startedAt,
        finishedAt: update.finishedAt === undefined ? current.finishedAt : update.finishedAt,
        errorText: update.errorText === undefined ? current.errorText : update.errorText,
      }

      database
        .query(
          "UPDATE run SET status = ?, started_at = ?, finished_at = ?, error_text = ? WHERE id = ?",
        )
        .run(
          record.status,
          record.startedAt,
          record.finishedAt,
          record.errorText,
          record.id,
        )

      return record
    },
  }

  const messages = {
    create(message: CreateMessageInput): StoredMessage {
      requireSession(message.sessionId)
      requireRunOwnership(message.runId, message.sessionId)

      const record: StoredMessage = {
        id: buildId("message", message.id),
        sessionId: message.sessionId,
        runId: message.runId,
        role: message.role,
        sequence: message.sequence,
        createdAt: message.createdAt ?? now(),
      }

      database
        .query(
          "INSERT INTO message (id, session_id, run_id, role, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.id,
          record.sessionId,
          record.runId,
          record.role,
          record.sequence,
          record.createdAt,
        )

      return record
    },
    get(messageId: string) {
      return requireMessage(messageId)
    },
    listSessionTranscript(sessionId: string): TranscriptMessage[] {
      requireSession(sessionId)

      const rows = database
        .query(
          `
            SELECT
              message.id AS message_id,
              message.session_id AS message_session_id,
              message.run_id AS message_run_id,
              message.role AS message_role,
              message.sequence AS message_sequence,
              message.created_at AS message_created_at,
              part.id AS part_id,
              part.session_id AS part_session_id,
              part.run_id AS part_run_id,
              part.message_id AS part_message_id,
              part.kind AS part_kind,
              part.sequence AS part_sequence,
              part.text_value AS part_text_value,
              part.data_json AS part_data_json,
              part.created_at AS part_created_at
            FROM message
            JOIN run ON run.id = message.run_id
            LEFT JOIN part ON part.message_id = message.id
            WHERE message.session_id = ?
            ORDER BY
              run.created_at ASC,
              run.id ASC,
              message.sequence ASC,
              message.id ASC,
              part.sequence ASC,
              part.id ASC
          `,
        )
        .all(sessionId) as TranscriptRow[]

      const transcript: TranscriptMessage[] = []
      const messagesById = new Map<string, TranscriptMessage>()

      for (const row of rows) {
        let message = messagesById.get(row.message_id)

        if (!message) {
          message = {
            id: row.message_id,
            sessionId: row.message_session_id,
            runId: row.message_run_id,
            role: row.message_role,
            sequence: row.message_sequence,
            createdAt: row.message_created_at,
            parts: [],
          }
          messagesById.set(message.id, message)
          transcript.push(message)
        }

        if (!row.part_id) {
          continue
        }

        message.parts.push(
          mapPartRow({
            id: row.part_id,
            session_id: row.part_session_id!,
            run_id: row.part_run_id!,
            message_id: row.part_message_id!,
            kind: row.part_kind!,
            sequence: row.part_sequence!,
            text_value: row.part_text_value,
            data_json: row.part_data_json,
            created_at: row.part_created_at!,
          }),
        )
      }

      return transcript
    },
  }

  const parts = {
    create(part: CreatePartInput): StoredPart {
      requireSession(part.sessionId)
      requireRunOwnership(part.runId, part.sessionId)
      requireMessageOwnership(part.messageId, part.runId, part.sessionId)

      const record: StoredPart = {
        id: buildId("part", part.id),
        sessionId: part.sessionId,
        runId: part.runId,
        messageId: part.messageId,
        kind: part.kind,
        sequence: part.sequence,
        text: part.text ?? null,
        data: part.data ?? null,
        createdAt: part.createdAt ?? now(),
      }

      database
        .query(
          `
            INSERT INTO part (
              id,
              session_id,
              run_id,
              message_id,
              kind,
              sequence,
              text_value,
              data_json,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.id,
          record.sessionId,
          record.runId,
          record.messageId,
          record.kind,
          record.sequence,
          record.text,
          serializeJson(record.data),
          record.createdAt,
        )

      return record
    },
    get(partId: string) {
      return requirePart(partId)
    },
    updateContent(update: UpdatePartContentInput) {
      const current = requirePart(update.partId)
      const record: StoredPart = {
        ...current,
        text: update.text === undefined ? current.text : update.text,
        data: update.data === undefined ? current.data : update.data,
      }

      database
        .query("UPDATE part SET text_value = ?, data_json = ? WHERE id = ?")
        .run(record.text, serializeJson(record.data), record.id)

      return record
    },
  }

  const permissionRequests = {
    create(request: CreatePermissionRequestInput): StoredPermissionRequest {
      requireSession(request.sessionId)
      requireRunOwnership(request.runId, request.sessionId)

      const record: StoredPermissionRequest = {
        id: buildId("permission", request.id),
        sessionId: request.sessionId,
        runId: request.runId,
        toolName: request.toolName,
        reason: request.reason,
        status: request.status ?? "pending",
        createdAt: request.createdAt ?? now(),
        resolvedAt: request.resolvedAt ?? null,
      }

      database
        .query(
          `
            INSERT INTO permission_request (
              id,
              session_id,
              run_id,
              tool_name,
              reason,
              status,
              created_at,
              resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.id,
          record.sessionId,
          record.runId,
          record.toolName,
          record.reason,
          record.status,
          record.createdAt,
          record.resolvedAt,
        )

      return record
    },
    get(requestId: string) {
      return requirePermissionRequest(requestId)
    },
    listByRun(runId: string) {
      requireRun(runId)
      return listPermissionRequestRowsByRun(runId).map(mapPermissionRequestRow)
    },
    updateStatus(update: UpdatePermissionRequestStatusInput) {
      const current = requirePermissionRequest(update.requestId)
      const record: StoredPermissionRequest = {
        ...current,
        status: update.status,
        resolvedAt: update.resolvedAt === undefined ? current.resolvedAt : update.resolvedAt,
      }

      database
        .query("UPDATE permission_request SET status = ?, resolved_at = ? WHERE id = ?")
        .run(record.status, record.resolvedAt, record.id)

      return record
    },
  }

  const createQueuedRunWithInitiatingMessageTransaction = database.transaction(
    (value: CreateQueuedRunWithInitiatingMessageInput) => {
      const activeRun = getActiveRunRowBySession(value.run.sessionId)
      if (activeRun) {
        throw new StorageConflictError(
          `Session ${value.run.sessionId} already has active run ${activeRun.id}`,
        )
      }

      const run = runs.create({
        ...value.run,
        status: "queued",
      })
      const message = messages.create({
        id: value.message.id,
        sessionId: run.sessionId,
        runId: run.id,
        role: "user",
        sequence: value.message.sequence ?? 0,
        createdAt: value.message.createdAt,
      })

      return { run, message }
    },
  )

  const createAssistantMessageWithFirstPartTransaction = database.transaction(
    (value: CreateAssistantMessageWithFirstPartInput) => {
      const message = messages.create({
        ...value.message,
        role: "assistant",
      })
      const part = parts.create({
        ...value.part,
        sessionId: message.sessionId,
        runId: message.runId,
        messageId: message.id,
      })

      return { message, part }
    },
  )

  const requestPermissionAndPauseRunTransaction = database.transaction(
    (value: RequestPermissionAndPauseRunInput) => {
      assertPendingPermissionRequestInput(value.permissionRequest)
      const currentRun = runs.get(value.runId)
      const run = runs.updateStatus({
        runId: currentRun.id,
        status: "waiting_permission",
      })
      const permissionRequest = permissionRequests.create({
        id: value.permissionRequest.id,
        sessionId: currentRun.sessionId,
        runId: currentRun.id,
        toolName: value.permissionRequest.toolName,
        reason: value.permissionRequest.reason,
        createdAt: value.permissionRequest.createdAt,
        status: "pending",
        resolvedAt: null,
      })

      return { run, permissionRequest }
    },
  )

  const cancelRunAndPendingPermissionsTransaction = database.transaction(
    (value: CancelRunAndPendingPermissionsInput) => {
      const currentRun = runs.get(value.runId)
      const run = runs.updateStatus({
        runId: currentRun.id,
        status: "cancelled",
        finishedAt: value.finishedAt ?? now(),
        errorText: null,
      })
      const resolvedAt = value.resolvedAt ?? run.finishedAt ?? now()
      const permissionRequests = listPermissionRequestRowsByRun(currentRun.id)
        .filter((request) => request.status === "pending")
        .map((request) =>
          permissionRequestsApi.updateStatus({
            requestId: request.id,
            status: "cancelled",
            resolvedAt,
          }),
        )

      return { run, permissionRequests }
    },
  )

  const permissionRequestsApi = permissionRequests

  return {
    storageIdentity,
    sessions,
    runs,
    messages,
    parts,
    permissionRequests,
    createQueuedRunWithInitiatingMessage(input: CreateQueuedRunWithInitiatingMessageInput) {
      return createQueuedRunWithInitiatingMessageTransaction(input)
    },
    createAssistantMessageWithFirstPart(input: CreateAssistantMessageWithFirstPartInput) {
      return createAssistantMessageWithFirstPartTransaction(input)
    },
    requestPermissionAndPauseRun(input: RequestPermissionAndPauseRunInput) {
      return requestPermissionAndPauseRunTransaction(input)
    },
    cancelRunAndPendingPermissions(input: CancelRunAndPendingPermissionsInput) {
      return cancelRunAndPendingPermissionsTransaction(input)
    },
  }
}

function mapSessionRow(row: SessionRow): StoredSession {
  return {
    id: row.id,
    directory: row.directory,
    workspaceRoot: row.workspace_root,
    createdAt: row.created_at,
  }
}

function mapRunRow(row: RunRow): StoredRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    trigger: row.trigger,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorText: row.error_text,
  }
}

function mapMessageRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    role: row.role,
    sequence: row.sequence,
    createdAt: row.created_at,
  }
}

function mapPartRow(row: PartRow): StoredPart {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    messageId: row.message_id,
    kind: row.kind,
    sequence: row.sequence,
    text: row.text_value,
    data: parseJson(row.data_json),
    createdAt: row.created_at,
  }
}

function mapPermissionRequestRow(row: PermissionRequestRow): StoredPermissionRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    toolName: row.tool_name,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

function serializeJson(value: unknown) {
  if (value === null || value === undefined) {
    return null
  }
  return JSON.stringify(value)
}

function parseJson(value: string | null) {
  if (value === null) {
    return null
  }
  return JSON.parse(value)
}

function assertPendingPermissionRequestInput(
  input: RequestPermissionAndPauseRunInput["permissionRequest"],
) {
  const permissionRequest = input as Record<string, unknown>

  if ("status" in permissionRequest || "resolvedAt" in permissionRequest) {
    throw new StorageRepositoryError(
      "requestPermissionAndPauseRun only creates pending unresolved permission requests",
    )
  }
}
