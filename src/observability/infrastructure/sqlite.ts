import { Database } from "bun:sqlite"

import {
  RUN_EVENT_SOURCES,
  type CreateRunEventInput,
  type ObservabilityRepository,
  type RunEventData,
  type StoredRunEvent,
} from "../application"

type RunEventRow = {
  id: string
  session_id: string
  run_id: string
  sequence: number
  source: StoredRunEvent["source"]
  event_type: string
  data_json: string
  created_at: number
}

export type ObservabilityDatabase = Database
export type ObservabilityEntityIdPrefix = "event"
export type CreateObservabilityRepositoryInput = {
  database: ObservabilityDatabase
  now?: () => number
  createId?: (prefix: ObservabilityEntityIdPrefix) => string
}

const runEventSourceCheck = RUN_EVENT_SOURCES.map((source) => `'${source}'`).join(", ")

export function createObservabilityRepository(
  input: CreateObservabilityRepositoryInput,
): ObservabilityRepository {
  const database = input.database
  const now = input.now ?? Date.now
  const createId =
    input.createId ?? ((prefix: ObservabilityEntityIdPrefix) => `${prefix}_${crypto.randomUUID()}`)

  ensureObservabilitySchema(database)

  const appendRunEventTransaction = database.transaction((value: CreateRunEventInput) => {
    const sequence = getNextRunEventSequence(database, value.runId)
    const record: StoredRunEvent = {
      id: value.id ?? createId("event"),
      sessionId: value.sessionId,
      runId: value.runId,
      sequence,
      source: value.source,
      eventType: value.eventType,
      data: value.data ?? {},
      createdAt: value.createdAt ?? now(),
    }

    database
      .query(
        `
          INSERT INTO run_event (
            id,
            session_id,
            run_id,
            sequence,
            source,
            event_type,
            data_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        record.id,
        record.sessionId,
        record.runId,
        record.sequence,
        record.source,
        record.eventType,
        serializeRunEventData(record.data),
        record.createdAt,
      )

    return record
  })

  return {
    runEvents: {
      append(inputValue: CreateRunEventInput) {
        return appendRunEventTransaction(inputValue)
      },
      listByRun(runId: string) {
        const rows = database
          .query(
            `
              SELECT id, session_id, run_id, sequence, source, event_type, data_json, created_at
              FROM run_event
              WHERE run_id = ?
              ORDER BY sequence ASC
            `,
          )
          .all(runId) as RunEventRow[]

        return rows.map(mapRunEventRow)
      },
    },
  }
}

function ensureObservabilitySchema(database: ObservabilityDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS run_event (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      source TEXT NOT NULL CHECK (source IN (${runEventSourceCheck})),
      event_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (run_id, sequence)
    )
  `)
  database.exec(`
    CREATE INDEX IF NOT EXISTS run_event_session_run_sequence_idx
    ON run_event (session_id, run_id, sequence)
  `)
}

function getNextRunEventSequence(database: ObservabilityDatabase, runId: string) {
  const row = database
    .query(
      `
        SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
        FROM run_event
        WHERE run_id = ?
      `,
    )
    .get(runId) as { next_sequence: number } | null

  return row?.next_sequence ?? 0
}

function serializeRunEventData(value: RunEventData) {
  return JSON.stringify(value)
}

function mapRunEventRow(row: RunEventRow): StoredRunEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    sequence: row.sequence,
    source: row.source,
    eventType: row.event_type,
    data: JSON.parse(row.data_json) as RunEventData,
    createdAt: row.created_at,
  }
}
