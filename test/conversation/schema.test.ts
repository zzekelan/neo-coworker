import { afterEach, describe, expect, test } from "bun:test"
// @ts-expect-error Bun runtime module is provided by Bun.
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  SESSION_TABLES as STORAGE_TABLES,
  CURRENT_SESSION_SCHEMA_VERSION as CURRENT_STORAGE_SCHEMA_VERSION,
  openSessionDatabase as openStorageDatabase,
} from "../../src/session"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []
const bunRuntime = (globalThis as unknown as {
  Bun: {
    file(path: string): { size: number }
  }
}).Bun

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

    expect(databasePath).toSatisfy((value: string) => bunRuntime.file(value).size > 0)
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

  test("cascade delete: deleting a parent session removes child sessions and their transcript rows", () => {
    const database = trackDatabase(openStorageDatabase(createDatabasePath("parent-session-cascade")))

    database.exec(`
      INSERT INTO session (
        id,
        directory,
        workspace_root,
        created_at,
        title,
        updated_at,
        latest_user_message_preview,
        active_skills_json,
        parent_session_id
      )
      VALUES ('session_parent', '/workspace', '/workspace', 1, 'Parent session', 1, NULL, '[]', NULL);

      INSERT INTO session (
        id,
        directory,
        workspace_root,
        created_at,
        title,
        updated_at,
        latest_user_message_preview,
        active_skills_json,
        parent_session_id
      )
      VALUES ('session_child', '/workspace', '/workspace', 2, 'Child session', 2, 'child prompt', '["reviewer"]', 'session_parent');

      INSERT INTO run (
        id,
        session_id,
        trigger,
        status,
        created_at,
        session_sequence,
        started_at,
        finished_at,
        error_text,
        active_skills_json,
        input_tokens,
        output_tokens,
        token_usage_source,
        parent_run_id
      )
      VALUES ('run_child', 'session_child', 'prompt', 'completed', 3, 0, 4, 5, NULL, '["reviewer"]', 0, 0, NULL, NULL);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_child', 'session_child', 'run_child', 'assistant', 0, 6);

      INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, created_at, text_value)
      VALUES ('part_child', 'session_child', 'run_child', 'message_child', 'text', 0, 7, 'done');

      INSERT INTO permission_request (id, session_id, run_id, tool_name, reason, status, created_at)
      VALUES ('permission_child', 'session_child', 'run_child', 'write', 'Need child cleanup', 'pending', 8);
    `)

    database.exec("DELETE FROM session WHERE id = 'session_parent'")

    expect(countRows(database, "session")).toBe(0)
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

  test("happy path: migrates v8 session records to v9 with nullable parent_session_id", () => {
    const databasePath = createDatabasePath("parent-session-migration")
    const seeded = trackDatabase(new Database(databasePath, { create: true, strict: true }))

    seeded.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT 'New session',
        updated_at INTEGER NOT NULL DEFAULT 0,
        latest_user_message_preview TEXT,
        active_skills_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE run (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('cli', 'prompt', 'command', 'shell', 'retry', 'summarize', 'init')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_permission', 'completed', 'failed', 'cancelled')),
        created_at INTEGER NOT NULL,
        session_sequence INTEGER NOT NULL DEFAULT -1,
        started_at INTEGER,
        finished_at INTEGER,
        error_text TEXT,
        active_skills_json TEXT NOT NULL DEFAULT '[]',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        token_usage_source TEXT CHECK (token_usage_source IN ('provider', 'estimated')),
        parent_run_id TEXT,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        UNIQUE (id, session_id)
      );

      CREATE UNIQUE INDEX run_session_sequence_idx
      ON run (session_id, session_sequence)
      WHERE session_sequence >= 0;

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
      END;

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'synthetic')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
        UNIQUE (id, run_id, session_id),
        UNIQUE (run_id, sequence)
      );

      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'reasoning', 'tool_call', 'tool_result', 'step_start', 'step_finish', 'error', 'patch', 'compaction_boundary')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        text_value TEXT,
        data_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
        FOREIGN KEY (message_id, run_id, session_id) REFERENCES message(id, run_id, session_id) ON DELETE CASCADE,
        UNIQUE (id, message_id, run_id, session_id),
        UNIQUE (message_id, sequence)
      );

      CREATE TABLE permission_request (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE
      );

      PRAGMA user_version = 8;

      INSERT INTO session (
        id,
        directory,
        workspace_root,
        created_at,
        title,
        updated_at,
        latest_user_message_preview,
        active_skills_json
      )
      VALUES ('session_1', '/workspace', '/workspace', 1, 'Parent title', 9, 'preview text', '["reviewer"]');

      INSERT INTO run (
        id,
        session_id,
        trigger,
        status,
        created_at,
        session_sequence,
        started_at,
        finished_at,
        error_text,
        active_skills_json,
        input_tokens,
        output_tokens,
        token_usage_source,
        parent_run_id
      )
      VALUES ('run_1', 'session_1', 'prompt', 'completed', 2, 0, 3, 4, NULL, '["reviewer"]', 5, 7, 'provider', NULL);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_1', 'session_1', 'run_1', 'assistant', 0, 5);

      INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, text_value, data_json, created_at)
      VALUES ('part_1', 'session_1', 'run_1', 'message_1', 'text', 0, 'existing answer', NULL, 6);

      INSERT INTO permission_request (id, session_id, run_id, tool_name, reason, status, created_at)
      VALUES ('permission_1', 'session_1', 'run_1', 'shell', 'Need to run a command', 'approved', 7);
    `)
    seeded.close(false)
    openDatabases.pop()

    const migrated = trackDatabase(openStorageDatabase(databasePath))
    const version = migrated.query("PRAGMA user_version").get() as { user_version: number }
    const columns = migrated.query("PRAGMA table_info(session)").all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }>
    const foreignKeys = migrated.query("PRAGMA foreign_key_list(session)").all() as Array<{
      table: string
      from: string
      to: string
      on_delete: string
    }>
    const session = migrated
      .query(
        "SELECT id, title, updated_at, latest_user_message_preview, active_skills_json, parent_session_id FROM session WHERE id = 'session_1'",
      )
      .get() as {
      id: string
      title: string
      updated_at: number
      latest_user_message_preview: string | null
      active_skills_json: string
      parent_session_id: string | null
    }
    const run = migrated
      .query(
        "SELECT id, session_id, parent_run_id, input_tokens, output_tokens, token_usage_source FROM run WHERE id = 'run_1'",
      )
      .get() as {
      id: string
      session_id: string
      parent_run_id: string | null
      input_tokens: number
      output_tokens: number
      token_usage_source: string | null
    }
    const message = migrated.query("SELECT id, session_id, run_id FROM message WHERE id = 'message_1'").get() as {
      id: string
      session_id: string
      run_id: string
    }

    expect(version.user_version).toBe(CURRENT_STORAGE_SCHEMA_VERSION)
    expect(columns.find((column) => column.name === 'parent_session_id')).toMatchObject({
      name: 'parent_session_id',
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
    })
    expect(
      foreignKeys.find((foreignKey) => foreignKey.from === 'parent_session_id'),
    ).toMatchObject({
      table: 'session',
      from: 'parent_session_id',
      to: 'id',
      on_delete: 'CASCADE',
    })
    expect(session).toEqual({
      id: 'session_1',
      title: 'Parent title',
      updated_at: 9,
      latest_user_message_preview: 'preview text',
      active_skills_json: '["reviewer"]',
      parent_session_id: null,
    })
    expect(run).toEqual({
      id: 'run_1',
      session_id: 'session_1',
      parent_run_id: null,
      input_tokens: 5,
      output_tokens: 7,
      token_usage_source: 'provider',
    })
    expect(message).toEqual({
      id: 'message_1',
      session_id: 'session_1',
      run_id: 'run_1',
    })
    expect(countRows(migrated, 'part')).toBe(1)
    expect(countRows(migrated, 'permission_request')).toBe(1)
    expect(countRows(migrated, 'permission_allowlist')).toBe(0)
  })

  test("migrates v5 run records to include token usage columns", () => {
    const databasePath = createDatabasePath("run-token-migration")
    const seeded = trackDatabase(new Database(databasePath, { create: true, strict: true }))

    seeded.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT 'New session',
        updated_at INTEGER NOT NULL DEFAULT 0,
        latest_user_message_preview TEXT,
        active_skills_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE run (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('cli', 'prompt', 'command', 'shell', 'retry', 'summarize', 'init')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_permission', 'completed', 'failed', 'cancelled')),
        created_at INTEGER NOT NULL,
        session_sequence INTEGER NOT NULL DEFAULT -1,
        started_at INTEGER,
        finished_at INTEGER,
        error_text TEXT,
        active_skills_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        UNIQUE (id, session_id)
      );

      CREATE UNIQUE INDEX run_session_sequence_idx
      ON run (session_id, session_sequence)
      WHERE session_sequence >= 0;

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
      END;

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'synthetic')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
        UNIQUE (id, run_id, session_id),
        UNIQUE (run_id, sequence)
      );

      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'reasoning', 'tool_call', 'tool_result', 'step_start', 'step_finish', 'error', 'patch')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        text_value TEXT,
        data_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
        FOREIGN KEY (message_id, run_id, session_id) REFERENCES message(id, run_id, session_id) ON DELETE CASCADE,
        UNIQUE (id, message_id, run_id, session_id),
        UNIQUE (message_id, sequence)
      );

      CREATE TABLE permission_request (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE
      );

      PRAGMA user_version = 5;

      INSERT INTO session (id, directory, workspace_root, created_at, title, updated_at, latest_user_message_preview, active_skills_json)
      VALUES ('session_1', '/workspace', '/workspace', 1, 'Session', 1, NULL, '[]');

      INSERT INTO run (id, session_id, trigger, status, created_at, active_skills_json)
      VALUES ('run_1', 'session_1', 'cli', 'queued', 2, '[]');
    `)
    seeded.close(false)
    openDatabases.pop()

    const migrated = trackDatabase(openStorageDatabase(databasePath))
    const columns = migrated.query("PRAGMA table_info(run)").all() as Array<{ name: string }>
    const usage = migrated
      .query("SELECT input_tokens, output_tokens, token_usage_source FROM run WHERE id = 'run_1'")
      .get() as {
      input_tokens: number
      output_tokens: number
      token_usage_source: string | null
    }

    expect(columns.map((column) => column.name)).toContain("input_tokens")
    expect(columns.map((column) => column.name)).toContain("output_tokens")
    expect(columns.map((column) => column.name)).toContain("token_usage_source")
    expect(usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      token_usage_source: null,
    })
  })

  test("migrates v6 part records to allow compaction boundaries", () => {
    const databasePath = createDatabasePath("compaction-boundary-migration")
    const seeded = trackDatabase(new Database(databasePath, { create: true, strict: true }))

    seeded.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT 'New session',
        updated_at INTEGER NOT NULL DEFAULT 0,
        latest_user_message_preview TEXT,
        active_skills_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE run (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('cli', 'prompt', 'command', 'shell', 'retry', 'summarize', 'init')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_permission', 'completed', 'failed', 'cancelled')),
        created_at INTEGER NOT NULL,
        session_sequence INTEGER NOT NULL DEFAULT -1,
        started_at INTEGER,
        finished_at INTEGER,
        error_text TEXT,
        active_skills_json TEXT NOT NULL DEFAULT '[]',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        token_usage_source TEXT CHECK (token_usage_source IN ('provider', 'estimated')),
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        UNIQUE (id, session_id)
      );

      CREATE UNIQUE INDEX run_session_sequence_idx
      ON run (session_id, session_sequence)
      WHERE session_sequence >= 0;

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
      END;

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'synthetic')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
        UNIQUE (id, run_id, session_id),
        UNIQUE (run_id, sequence)
      );

      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'reasoning', 'tool_call', 'tool_result', 'step_start', 'step_finish', 'error', 'patch')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        text_value TEXT,
        data_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
        FOREIGN KEY (message_id, run_id, session_id) REFERENCES message(id, run_id, session_id) ON DELETE CASCADE,
        UNIQUE (id, message_id, run_id, session_id),
        UNIQUE (message_id, sequence)
      );

      CREATE TABLE permission_request (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE
      );

      PRAGMA user_version = 6;

      INSERT INTO session (id, directory, workspace_root, created_at, title, updated_at, latest_user_message_preview, active_skills_json)
      VALUES ('session_1', '/workspace', '/workspace', 1, 'Session', 1, NULL, '[]');

      INSERT INTO run (id, session_id, trigger, status, created_at, active_skills_json, input_tokens, output_tokens, token_usage_source)
      VALUES ('run_1', 'session_1', 'prompt', 'completed', 2, '[]', 0, 0, NULL);

      INSERT INTO message (id, session_id, run_id, role, sequence, created_at)
      VALUES ('message_1', 'session_1', 'run_1', 'assistant', 0, 3);

      INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, text_value, data_json, created_at)
      VALUES ('part_1', 'session_1', 'run_1', 'message_1', 'text', 0, 'existing summary', NULL, 4);
    `)
    seeded.close(false)
    openDatabases.pop()

    const migrated = trackDatabase(openStorageDatabase(databasePath))
    const kinds = migrated
      .query("SELECT kind FROM part ORDER BY sequence ASC")
      .all() as Array<{ kind: string }>

    expect(() =>
      migrated
        .query(
          "INSERT INTO part (id, session_id, run_id, message_id, kind, sequence, text_value, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "part_boundary",
          "session_1",
          "run_1",
          "message_1",
          "compaction_boundary",
          1,
          null,
          '{"summarizeRunId":"run_summary"}',
          5,
        ),
    ).not.toThrow()
    const insertedKinds = migrated
      .query("SELECT kind FROM part ORDER BY sequence ASC")
      .all() as Array<{ kind: string }>
    expect(kinds.map((row) => row.kind)).toEqual(["text"])
    expect(insertedKinds.map((row) => row.kind)).toEqual(["text", "compaction_boundary"])
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
