export const CURRENT_STORAGE_SCHEMA_VERSION = 1

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
] as const

export const MESSAGE_ROLES = ["user", "assistant", "synthetic"] as const

export const PART_KINDS = [
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "step_start",
  "step_finish",
  "error",
  "patch",
] as const

export const PERMISSION_STATUSES = [
  "pending",
  "approved",
  "denied",
  "cancelled",
] as const

export const STORAGE_TABLES = [
  "session",
  "run",
  "message",
  "part",
  "permission_request",
] as const

const runStatusCheck = RUN_STATUSES.map((status) => `'${status}'`).join(", ")
const messageRoleCheck = MESSAGE_ROLES.map((role) => `'${role}'`).join(", ")
const partKindCheck = PART_KINDS.map((kind) => `'${kind}'`).join(", ")
const permissionStatusCheck = PERMISSION_STATUSES.map((status) => `'${status}'`).join(", ")

export const STORAGE_MIGRATIONS = [
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
          trigger TEXT NOT NULL CHECK (trigger IN ('cli')),
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
] as const
