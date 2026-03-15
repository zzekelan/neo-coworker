import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CONVERSATION_TABLES as STORAGE_TABLES,
  CURRENT_CONVERSATION_SCHEMA_VERSION as CURRENT_STORAGE_SCHEMA_VERSION,
  openConversationDatabase as openStorageDatabase,
} from "../../src/conversation/repo"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("storage schema", () => {
  test("empty-database bootstrap creates the expected schema", () => {
    const databasePath = createDatabasePath("bootstrap")
    const database = trackDatabase(openStorageDatabase(databasePath))

    const tables = database
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>

    expect(databasePath).toSatisfy((value) => Bun.file(value).size > 0)
    expect(tables.map((row) => row.name)).toEqual([...STORAGE_TABLES].sort())

    const version = database.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(CURRENT_STORAGE_SCHEMA_VERSION)
  })

  test("fresh bootstrap supports the approved final run triggers directly", () => {
    const database = trackDatabase(openStorageDatabase(createDatabasePath("final-triggers")))

    database.exec(`
      INSERT INTO session (id, directory, workspace_root, created_at)
      VALUES ('session_1', '/workspace', '/workspace', 1);
    `)

    expect(() =>
      database
        .query(
          "INSERT INTO run (id, session_id, trigger, status, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("run_prompt", "session_1", "prompt", "queued", 2),
    ).not.toThrow()

    expect(() =>
      database
        .query(
          "INSERT INTO run (id, session_id, trigger, status, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("run_retry", "session_1", "retry", "queued", 3),
    ).not.toThrow()
  })

  test("foreign-key violations fail for mismatched session or run ownership", () => {
    const database = trackDatabase(openStorageDatabase(createDatabasePath("ownership")))

    database.exec(`
      INSERT INTO session (id, directory, workspace_root, created_at)
      VALUES ('session_a', '/workspace', '/workspace', 1);

      INSERT INTO session (id, directory, workspace_root, created_at)
      VALUES ('session_b', '/workspace-alt', '/workspace-alt', 2);

      INSERT INTO run (id, session_id, trigger, status, created_at)
      VALUES ('run_a', 'session_a', 'cli', 'queued', 3);
    `)

    expect(() =>
      database
        .query(
          "INSERT INTO message (id, session_id, run_id, role, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("message_mismatch", "session_b", "run_a", "user", 0, 4),
    ).toThrow(/FOREIGN KEY|constraint/i)

    database.exec(`
      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_ok', 'session_a', 'run_a', 'assistant', 1, 5);
    `)

    expect(() =>
      database
        .query(
          "INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("part_mismatch", "session_b", "run_a", "message_ok", "text", 0, 6),
    ).toThrow(/FOREIGN KEY|constraint/i)
  })

  test("deleting a session cascades correctly", () => {
    const database = trackDatabase(openStorageDatabase(createDatabasePath("cascade")))

    database.exec(`
      INSERT INTO session (id, directory, workspace_root, created_at)
      VALUES ('session_1', '/workspace', '/workspace', 1);

      INSERT INTO run (id, session_id, trigger, status, created_at)
      VALUES ('run_1', 'session_1', 'cli', 'running', 2);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_1', 'session_1', 'run_1', 'user', 0, 3);

      INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, created_at, text_value)
      VALUES ('part_1', 'session_1', 'run_1', 'message_1', 'text', 0, 4, 'hello');

      INSERT INTO permission_request (id, session_id, run_id, tool_name, reason, status, created_at)
      VALUES ('permission_1', 'session_1', 'run_1', 'write', 'Need to modify a file', 'pending', 5);
    `)

    database.exec("DELETE FROM session WHERE id = 'session_1'")

    expect(countRows(database, "run")).toBe(0)
    expect(countRows(database, "message")).toBe(0)
    expect(countRows(database, "part")).toBe(0)
    expect(countRows(database, "permission_request")).toBe(0)
  })

  test("ordering fields sort messages and parts deterministically", () => {
    const database = trackDatabase(openStorageDatabase(createDatabasePath("ordering")))

    database.exec(`
      INSERT INTO session (id, directory, workspace_root, created_at)
      VALUES ('session_1', '/workspace', '/workspace', 1);

      INSERT INTO run (id, session_id, trigger, status, created_at)
      VALUES ('run_1', 'session_1', 'cli', 'running', 2);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_2', 'session_1', 'run_1', 'assistant', 2, 5);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_0', 'session_1', 'run_1', 'user', 0, 3);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_1', 'session_1', 'run_1', 'assistant', 1, 4);

      INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, created_at, text_value)
      VALUES ('part_2', 'session_1', 'run_1', 'message_1', 'text', 2, 8, 'third');

      INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, created_at, text_value)
      VALUES ('part_0', 'session_1', 'run_1', 'message_1', 'step_start', 0, 6, 'first');

      INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, created_at, text_value)
      VALUES ('part_1', 'session_1', 'run_1', 'message_1', 'text', 1, 7, 'second');
    `)

    const messages = database
      .query("SELECT id FROM message WHERE run_id = 'run_1' ORDER BY sequence")
      .all() as Array<{ id: string }>
    const parts = database
      .query("SELECT id FROM part WHERE message_id = 'message_1' ORDER BY sequence")
      .all() as Array<{ id: string }>

    expect(messages.map((row) => row.id)).toEqual(["message_0", "message_1", "message_2"])
    expect(parts.map((row) => row.id)).toEqual(["part_0", "part_1", "part_2"])
  })

  test("one session can keep messages from separate runs distinct", () => {
    const database = trackDatabase(openStorageDatabase(createDatabasePath("separate-runs")))

    database.exec(`
      INSERT INTO session (id, directory, workspace_root, created_at)
      VALUES ('session_1', '/workspace', '/workspace', 1);

      INSERT INTO run (id, session_id, trigger, status, created_at)
      VALUES ('run_1', 'session_1', 'cli', 'completed', 2);

      INSERT INTO run (id, session_id, trigger, status, created_at)
      VALUES ('run_2', 'session_1', 'cli', 'running', 3);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_run_1', 'session_1', 'run_1', 'user', 0, 4);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_run_2', 'session_1', 'run_2', 'user', 0, 5);
    `)

    const runOneMessages = database
      .query("SELECT id FROM message WHERE run_id = 'run_1' ORDER BY sequence")
      .all() as Array<{ id: string }>
    const runTwoMessages = database
      .query("SELECT id FROM message WHERE run_id = 'run_2' ORDER BY sequence")
      .all() as Array<{ id: string }>

    expect(runOneMessages.map((row) => row.id)).toEqual(["message_run_1"])
    expect(runTwoMessages.map((row) => row.id)).toEqual(["message_run_2"])
  })

  test("one run can store an initiating user message and an assistant message with multiple parts", () => {
    const database = trackDatabase(openStorageDatabase(createDatabasePath("message-shape")))

    database.exec(`
      INSERT INTO session (id, directory, workspace_root, created_at)
      VALUES ('session_1', '/workspace', '/workspace', 1);

      INSERT INTO run (id, session_id, trigger, status, created_at)
      VALUES ('run_1', 'session_1', 'cli', 'running', 2);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_user', 'session_1', 'run_1', 'user', 0, 3);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_assistant', 'session_1', 'run_1', 'assistant', 1, 4);

      INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, created_at, text_value)
      VALUES ('part_step', 'session_1', 'run_1', 'message_assistant', 'step_start', 0, 5, 'start');

      INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, created_at, text_value)
      VALUES ('part_text', 'session_1', 'run_1', 'message_assistant', 'text', 1, 6, 'done');
    `)

    const messages = database
      .query("SELECT id, role FROM message WHERE run_id = 'run_1' ORDER BY sequence")
      .all() as Array<{ id: string; role: string }>
    const assistantParts = database
      .query("SELECT id, kind FROM part WHERE message_id = 'message_assistant' ORDER BY sequence")
      .all() as Array<{ id: string; kind: string }>

    expect(messages).toEqual([
      { id: "message_user", role: "user" },
      { id: "message_assistant", role: "assistant" },
    ])
    expect(assistantParts).toEqual([
      { id: "part_step", kind: "step_start" },
      { id: "part_text", kind: "text" },
    ])
  })

  test("pending permission request can be stored for an existing run", () => {
    const database = trackDatabase(openStorageDatabase(createDatabasePath("permission")))

    database.exec(`
      INSERT INTO session (id, directory, workspace_root, created_at)
      VALUES ('session_1', '/workspace', '/workspace', 1);

      INSERT INTO run (id, session_id, trigger, status, created_at)
      VALUES ('run_1', 'session_1', 'cli', 'waiting_permission', 2);

      INSERT INTO permission_request (id, session_id, run_id, tool_name, reason, status, created_at)
      VALUES ('permission_1', 'session_1', 'run_1', 'shell', 'Need to run git status', 'pending', 3);
    `)

    const stored = database.query("SELECT * FROM permission_request").get() as {
      id: string
      run_id: string
      session_id: string
      status: string
      tool_name: string
    }

    expect(stored).toMatchObject({
      id: "permission_1",
      run_id: "run_1",
      session_id: "session_1",
      status: "pending",
      tool_name: "shell",
    })
  })

  test("invalid run and permission statuses are rejected", () => {
    const database = trackDatabase(openStorageDatabase(createDatabasePath("invalid-status")))

    database.exec(`
      INSERT INTO session (id, directory, workspace_root, created_at)
      VALUES ('session_1', '/workspace', '/workspace', 1);
    `)

    expect(() =>
      database
        .query(
          "INSERT INTO run (id, session_id, trigger, status, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("run_bad", "session_1", "cli", "paused", 2),
    ).toThrow(/CHECK|constraint/i)

    database.exec(`
      INSERT INTO run (id, session_id, trigger, status, created_at)
      VALUES ('run_1', 'session_1', 'cli', 'queued', 3);
    `)

    expect(() =>
      database
        .query(
          "INSERT INTO permission_request (id, session_id, run_id, tool_name, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "permission_bad",
          "session_1",
          "run_1",
          "write",
          "Need to edit a file",
          "later",
          4,
        ),
    ).toThrow(/CHECK|constraint/i)
  })

  test("schema initialization failures surface as explicit setup errors", () => {
    const databasePath = createDatabasePath("future-version")
    const seeded = trackDatabase(openStorageDatabase(databasePath))

    seeded.exec("PRAGMA user_version = 999")
    seeded.close(false)
    openDatabases.pop()

    expect(() => openStorageDatabase(databasePath)).toThrow(
      `Failed to initialize storage at ${databasePath}: Database schema version 999 is newer than supported version ${CURRENT_STORAGE_SCHEMA_VERSION}`,
    )
  })
})

function createDatabasePath(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `neo-coworker-${prefix}-`))
  tempDirectories.push(directory)
  return join(directory, "agent.sqlite")
}

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}

function countRows(database: { query: (sql: string) => { get: () => unknown } }, table: string) {
  const row = database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  return row.count
}
