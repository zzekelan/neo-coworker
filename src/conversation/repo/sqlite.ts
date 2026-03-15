import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"

import {
  CURRENT_CONVERSATION_SCHEMA_VERSION,
  MESSAGE_ROLES,
  PART_KINDS,
  PERMISSION_STATUSES,
  RUN_STATUSES,
  RUN_TRIGGERS,
} from "../config/defaults"
import {
  ConversationConflictError,
  ConversationNotFoundError,
  ConversationOwnershipError,
  type ConversationRepository,
  type CancelRunAndPendingPermissionsInput,
  type CreateAssistantMessageWithFirstPartInput,
  type CreateMessageInput,
  type CreatePartInput,
  type CreatePermissionRequestInput,
  type CreateQueuedRunWithInitiatingMessageInput,
  type CreateRunInput,
  type CreateSessionInput,
  type RequestPermissionAndPauseRunInput,
  type StoredMessage,
  type StoredPart,
  type StoredPermissionRequest,
  type StoredRun,
  type StoredSession,
  type TranscriptMessage,
  type UpdatePartContentInput,
  type UpdatePermissionRequestStatusInput,
  type UpdateRunStatusInput,
} from "./contract"
import {
  mapMessageRow,
  mapPartRow,
  mapPermissionRequestRow,
  mapRunRow,
  mapSessionRow,
  serializeJson,
  type MessageRow,
  type PartRow,
  type PermissionRequestRow,
  type RunRow,
  type SessionRow,
  type TranscriptRow,
} from "./mappers"
import { assertPendingPermissionRequestInput } from "./tx"

export type ConversationDatabase = Database

const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_permission"] as const
const activeRunStatusCheck = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ")
const runStatusCheck = RUN_STATUSES.map((status) => `'${status}'`).join(", ")
const runTriggerCheck = RUN_TRIGGERS.map((trigger) => `'${trigger}'`).join(", ")
const messageRoleCheck = MESSAGE_ROLES.map((role) => `'${role}'`).join(", ")
const partKindCheck = PART_KINDS.map((kind) => `'${kind}'`).join(", ")
const permissionStatusCheck = PERMISSION_STATUSES.map((status) => `'${status}'`).join(", ")

const conversationMigrations = [
  {
    version: 1,
    statements: [
      `
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          directory TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `,
      `
        CREATE TABLE run (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK (trigger IN (${runTriggerCheck})),
          status TEXT NOT NULL CHECK (status IN (${runStatusCheck})),
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          error_text TEXT,
          FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
          UNIQUE (id, session_id)
        )
      `,
      `
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN (${messageRoleCheck})),
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
          FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
          UNIQUE (id, run_id, session_id),
          UNIQUE (run_id, sequence)
        )
      `,
      `
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (${partKindCheck})),
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          text_value TEXT,
          data_json TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
          FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
          FOREIGN KEY (message_id, run_id, session_id) REFERENCES message(id, run_id, session_id) ON DELETE CASCADE,
          UNIQUE (id, message_id, run_id, session_id),
          UNIQUE (message_id, sequence)
        )
      `,
      `
        CREATE TABLE permission_request (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (${permissionStatusCheck})),
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
          FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE
        )
      `,
    ],
  },
  {
    version: 2,
    statements: [
      `
        ALTER TABLE run
        ADD COLUMN session_sequence INTEGER NOT NULL DEFAULT -1
      `,
      `
        WITH ordered_runs AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY session_id
              ORDER BY created_at ASC, rowid ASC
            ) - 1 AS session_sequence
          FROM run
        )
        UPDATE run
        SET session_sequence = (
          SELECT ordered_runs.session_sequence
          FROM ordered_runs
          WHERE ordered_runs.id = run.id
        )
        WHERE session_sequence < 0
      `,
      `
        CREATE UNIQUE INDEX run_session_sequence_idx
        ON run (session_id, session_sequence)
        WHERE session_sequence >= 0
      `,
      `
        CREATE TRIGGER run_assign_session_sequence_after_insert
        AFTER INSERT ON run
        FOR EACH ROW
        WHEN NEW.session_sequence < 0
        BEGIN
          UPDATE run
          SET session_sequence = (
            SELECT COALESCE(MAX(session_sequence), -1) + 1
            FROM run
            WHERE session_id = NEW.session_id
              AND id <> NEW.id
              AND session_sequence >= 0
          )
          WHERE id = NEW.id;
        END
      `,
    ],
  },
] as const

type IdPrefix = "session" | "run" | "message" | "part" | "permission"

export function getConversationDatabaseIdentity(database: ConversationDatabase) {
  const filename = database.filename

  if (!filename || filename === ":memory:") {
    return `memory:${String(database.handle)}`
  }

  try {
    return realpathSync.native(filename)
  } catch {
    return resolve(filename)
  }
}

export function openConversationDatabase(filePath: string) {
  ensureParentDirectory(filePath)

  const database = new Database(filePath, { create: true, strict: true })

  try {
    configureDatabase(database)
    runConversationMigrations(database)
    return database
  } catch (error) {
    database.close(false)
    throw wrapConversationSetupError(filePath, error)
  }
}

export function createConversationRepository(input: {
  database: ConversationDatabase
  now?: () => number
  createId?: (prefix: IdPrefix) => string
}): ConversationRepository {
  const database = input.database
  const storageIdentity = getConversationDatabaseIdentity(database)
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
        "SELECT id, session_id, trigger, status, created_at, session_sequence, started_at, finished_at, error_text FROM run WHERE id = ?",
      )
      .get(runId) as RunRow | null
  }

  function listRunRowsBySession(sessionId: string) {
    return database
      .query(
        `
          SELECT id, session_id, trigger, status, created_at, session_sequence, started_at, finished_at, error_text
          FROM run
          WHERE session_id = ?
          ORDER BY created_at ASC, session_sequence ASC
        `,
      )
      .all(sessionId) as RunRow[]
  }

  function getLatestRunRowBySession(sessionId: string) {
    return database
      .query(
        `
          SELECT id, session_id, trigger, status, created_at, session_sequence, started_at, finished_at, error_text
          FROM run
          WHERE session_id = ?
          ORDER BY created_at DESC, session_sequence DESC
          LIMIT 1
        `,
      )
      .get(sessionId) as RunRow | null
  }

  function getActiveRunRowBySession(sessionId: string) {
    return database
      .query(
        `
          SELECT id, session_id, trigger, status, created_at, session_sequence, started_at, finished_at, error_text
          FROM run
          WHERE session_id = ? AND status IN (${activeRunStatusCheck})
          ORDER BY created_at DESC, session_sequence DESC
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
      throw new ConversationNotFoundError("session", sessionId)
    }

    return mapSessionRow(row)
  }

  function requireRun(runId: string) {
    const row = getRunRow(runId)
    if (!row) {
      throw new ConversationNotFoundError("run", runId)
    }

    return mapRunRow(row)
  }

  function requireRunOwnership(runId: string, sessionId: string) {
    const run = requireRun(runId)
    if (run.sessionId !== sessionId) {
      throw new ConversationOwnershipError(
        `Run ${runId} does not belong to session ${sessionId}`,
      )
    }

    return run
  }

  function requireMessage(messageId: string) {
    const row = getMessageRow(messageId)
    if (!row) {
      throw new ConversationNotFoundError("message", messageId)
    }

    return mapMessageRow(row)
  }

  function requireMessageOwnership(messageId: string, runId: string, sessionId: string) {
    const message = requireMessage(messageId)

    if (message.sessionId !== sessionId) {
      throw new ConversationOwnershipError(
        `Message ${messageId} does not belong to session ${sessionId}`,
      )
    }

    if (message.runId !== runId) {
      throw new ConversationOwnershipError(`Message ${messageId} does not belong to run ${runId}`)
    }

    return message
  }

  function requirePart(partId: string) {
    const row = getPartRow(partId)
    if (!row) {
      throw new ConversationNotFoundError("part", partId)
    }

    return mapPartRow(row)
  }

  function requirePermissionRequest(requestId: string) {
    const row = getPermissionRequestRow(requestId)
    if (!row) {
      throw new ConversationNotFoundError("permission_request", requestId)
    }

    return mapPermissionRequestRow(row)
  }

  const sessions: ConversationRepository["sessions"] = {
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

  const runs: ConversationRepository["runs"] = {
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

  const messages: ConversationRepository["messages"] = {
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
              run.session_sequence ASC,
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

  const parts: ConversationRepository["parts"] = {
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

  const permissionRequests: ConversationRepository["permissionRequests"] = {
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
        throw new ConversationConflictError(
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
      const permissionRequestsForRun = listPermissionRequestRowsByRun(currentRun.id)
        .filter((request) => request.status === "pending")
        .map((request) =>
          permissionRequests.updateStatus({
            requestId: request.id,
            status: "cancelled",
            resolvedAt,
          }),
        )

      return { run, permissionRequests: permissionRequestsForRun }
    },
  )

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

function ensureParentDirectory(filePath: string) {
  const parentDirectory = dirname(filePath)
  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true })
  }
}

function configureDatabase(database: ConversationDatabase) {
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA journal_mode = WAL")
}

function runConversationMigrations(database: ConversationDatabase) {
  const versionRow = database
    .query("PRAGMA user_version")
    .get() as { user_version: number } | null
  const currentVersion = versionRow?.user_version ?? 0

  if (currentVersion > CURRENT_CONVERSATION_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${CURRENT_CONVERSATION_SCHEMA_VERSION}`,
    )
  }

  for (const migration of conversationMigrations) {
    if (migration.version <= currentVersion) {
      continue
    }

    const applyMigration = database.transaction((statements: readonly string[], version: number) => {
      for (const statement of statements) {
        database.exec(statement)
      }
      database.exec(`PRAGMA user_version = ${version}`)
    })

    applyMigration(migration.statements, migration.version)
  }
}

function wrapConversationSetupError(filePath: string, error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"
  return new Error(`Failed to initialize storage at ${filePath}: ${message}`)
}
