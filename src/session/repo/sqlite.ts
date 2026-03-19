import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"

import {
  CURRENT_SESSION_SCHEMA_VERSION,
  MESSAGE_ROLES,
  PART_KINDS,
  RUN_STATUSES,
  RUN_TRIGGERS,
} from "../config/defaults"
import {
  SessionConflictError,
  SessionNotFoundError,
  SessionOwnershipError,
  type SessionRepository,
  type CreateAssistantMessageWithFirstPartInput,
  type CreateMessageInput,
  type CreatePartInput,
  type CreateQueuedRunWithInitiatingMessageInput,
  type CreateQueuedRunWithInitiatingMessageAndPartInput,
  type CreateRunInput,
  type CreateSessionInput,
  type StoredMessage,
  type StoredPart,
  type StoredRun,
  type StoredSession,
  type TranscriptMessage,
  type UpdatePartContentInput,
  type UpdateRunStatusInput,
} from "./contract"
import {
  mapMessageRow,
  mapPartRow,
  mapRunRow,
  mapSessionRow,
  serializeJson,
  type MessageRow,
  type PartRow,
  type RunRow,
  type SessionRow,
  type TranscriptRow,
} from "./mappers"

export type SessionDatabase = Database

const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_permission"] as const
const activeRunStatusCheck = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ")
const runStatusCheck = RUN_STATUSES.map((status) => `'${status}'`).join(", ")
const runTriggerCheck = RUN_TRIGGERS.map((trigger) => `'${trigger}'`).join(", ")
const messageRoleCheck = MESSAGE_ROLES.map((role) => `'${role}'`).join(", ")
const partKindCheck = PART_KINDS.map((kind) => `'${kind}'`).join(", ")
const permissionStatusCheck = ["pending", "approved", "denied", "cancelled"]
  .map((status) => `'${status}'`)
  .join(", ")

const sessionMigrations = [
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

type IdPrefix = "session" | "run" | "message" | "part"

export function getSessionDatabaseIdentity(database: SessionDatabase) {
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

export function openSessionDatabase(filePath: string) {
  ensureParentDirectory(filePath)

  const database = new Database(filePath, { create: true, strict: true })

  try {
    configureDatabase(database)
    runSessionMigrations(database)
    return database
  } catch (error) {
    database.close(false)
    throw wrapSessionSetupError(filePath, error)
  }
}

export function createSessionRepository(input: {
  database: SessionDatabase
  now?: () => number
  createId?: (prefix: IdPrefix) => string
}): SessionRepository {
  const database = input.database
  const storageIdentity = getSessionDatabaseIdentity(database)
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

  function requireSession(sessionId: string) {
    const row = getSessionRow(sessionId)
    if (!row) {
      throw new SessionNotFoundError("session", sessionId)
    }

    return mapSessionRow(row)
  }

  function requireRun(runId: string) {
    const row = getRunRow(runId)
    if (!row) {
      throw new SessionNotFoundError("run", runId)
    }

    return mapRunRow(row)
  }

  function requireRunOwnership(runId: string, sessionId: string) {
    const run = requireRun(runId)
    if (run.sessionId !== sessionId) {
      throw new SessionOwnershipError(
        `Run ${runId} does not belong to session ${sessionId}`,
      )
    }

    return run
  }

  function requireMessage(messageId: string) {
    const row = getMessageRow(messageId)
    if (!row) {
      throw new SessionNotFoundError("message", messageId)
    }

    return mapMessageRow(row)
  }

  function requireMessageOwnership(messageId: string, runId: string, sessionId: string) {
    const message = requireMessage(messageId)

    if (message.sessionId !== sessionId) {
      throw new SessionOwnershipError(
        `Message ${messageId} does not belong to session ${sessionId}`,
      )
    }

    if (message.runId !== runId) {
      throw new SessionOwnershipError(`Message ${messageId} does not belong to run ${runId}`)
    }

    return message
  }

  function requirePart(partId: string) {
    const row = getPartRow(partId)
    if (!row) {
      throw new SessionNotFoundError("part", partId)
    }

    return mapPartRow(row)
  }

  const sessions: SessionRepository["sessions"] = {
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

  const runs: SessionRepository["runs"] = {
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

  const messages: SessionRepository["messages"] = {
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

  const parts: SessionRepository["parts"] = {
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

  const createQueuedRunWithInitiatingMessageTransaction = database.transaction(
    (value: CreateQueuedRunWithInitiatingMessageInput) => {
      const activeRun = getActiveRunRowBySession(value.run.sessionId)
      if (activeRun) {
        throw new SessionConflictError(
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

  const createQueuedRunWithInitiatingMessageAndPartTransaction = database.transaction(
    (value: CreateQueuedRunWithInitiatingMessageAndPartInput) => {
      const { run, message } = createQueuedRunWithInitiatingMessageTransaction(value)
      const part = parts.create({
        ...value.part,
        sessionId: run.sessionId,
        runId: run.id,
        messageId: message.id,
      })

      return { run, message, part }
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

  return {
    storageIdentity,
    sessions,
    runs,
    messages,
    parts,
    createQueuedRunWithInitiatingMessage(input: CreateQueuedRunWithInitiatingMessageInput) {
      return createQueuedRunWithInitiatingMessageTransaction(input)
    },
    createQueuedRunWithInitiatingMessageAndPart(
      input: CreateQueuedRunWithInitiatingMessageAndPartInput,
    ) {
      return createQueuedRunWithInitiatingMessageAndPartTransaction(input)
    },
    createAssistantMessageWithFirstPart(input: CreateAssistantMessageWithFirstPartInput) {
      return createAssistantMessageWithFirstPartTransaction(input)
    },
  }
}

function ensureParentDirectory(filePath: string) {
  const parentDirectory = dirname(filePath)
  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true })
  }
}

function configureDatabase(database: SessionDatabase) {
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA journal_mode = WAL")
}

function runSessionMigrations(database: SessionDatabase) {
  const versionRow = database
    .query("PRAGMA user_version")
    .get() as { user_version: number } | null
  const currentVersion = versionRow?.user_version ?? 0

  if (currentVersion > CURRENT_SESSION_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${CURRENT_SESSION_SCHEMA_VERSION}`,
    )
  }

  for (const migration of sessionMigrations) {
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

function wrapSessionSetupError(filePath: string, error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"
  return new Error(`Failed to initialize storage at ${filePath}: ${message}`)
}
