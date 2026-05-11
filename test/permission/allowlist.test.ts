// @ts-expect-error Bun runtime module is provided by Bun.
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openSessionDatabase } from "../../src/session"
import {
  type PermissionObserverEvent,
  type PermissionObserverPort,
} from "../../src/permission"
import { createPermissionAllowlistStore } from "../../src/permission/infrastructure/allowlist"

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

describe("permission allowlist", () => {
  test("adds a shell command entry, persists it, and emits allowlist telemetry", async () => {
    const databasePath = createDatabasePath("allowlist-persist")
    const database = trackDatabase(openSessionDatabase(databasePath))
    const events: PermissionObserverEvent[] = []
    const observer: PermissionObserverPort = {
      recordPermissionEvent(event) {
        events.push(event)
      },
    }
    const store = createPermissionAllowlistStore({
      database,
      workspaceRoot: "/workspace-a",
      now: () => 1_700_000_000_000,
      observer,
    })

    const created = await store.add({
      toolName: "shell",
      pattern: "git status",
      reason: "safe read-only command",
    })

    expect(created).toMatchObject({
      toolName: "shell",
      pattern: "git status",
      scope: "workspace",
      reason: "safe read-only command",
    })
    expect(created.createdAt).toBeInstanceOf(Date)
    expect(await store.list()).toMatchObject([
      {
        toolName: "shell",
        pattern: "git status",
        scope: "workspace",
        reason: "safe read-only command",
      },
    ])
    expect(
      await store.isAllowed({
        toolName: "shell",
        reason: "shell git status",
      }),
    ).toBe(true)
    expect(events).toEqual([
      {
        type: "allowlist.checked",
        toolName: "shell",
        matched: true,
      },
      {
        type: "allowlist.auto_approved",
        toolName: "shell",
        pattern: "git status",
        scope: "workspace",
      },
    ])

    database.close(false)
    openDatabases.pop()

    const reopened = trackDatabase(openSessionDatabase(databasePath))
    const reopenedStore = createPermissionAllowlistStore({
      database: reopened,
      workspaceRoot: "/workspace-a",
    })

    expect(
      await reopenedStore.isAllowed({
        toolName: "shell",
        reason: "shell git status",
      }),
    ).toBe(true)
  })

  test("remove disables future matches and unmatched checks only emit checked telemetry", async () => {
    const database = trackDatabase(openSessionDatabase(createDatabasePath("allowlist-remove")))
    const events: PermissionObserverEvent[] = []
    const observer: PermissionObserverPort = {
      recordPermissionEvent(event) {
        events.push(event)
      },
    }
    const store = createPermissionAllowlistStore({
      database,
      workspaceRoot: "/workspace-a",
      observer,
    })

    await store.add({
      toolName: "shell",
      pattern: "git diff",
    })

    expect(await store.remove("git diff")).toBe(1)
    expect(await store.list()).toEqual([])
    expect(
      await store.isAllowed({
        toolName: "shell",
        reason: "shell git diff",
      }),
    ).toBe(false)
    expect(events).toEqual([
      {
        type: "allowlist.checked",
        toolName: "shell",
        matched: false,
      },
    ])
  })

  test("isolates entries by workspace root in the shared session database", async () => {
    const database = trackDatabase(openSessionDatabase(createDatabasePath("allowlist-workspaces")))
    const workspaceA = createPermissionAllowlistStore({
      database,
      workspaceRoot: "/workspace-a",
    })
    const workspaceB = createPermissionAllowlistStore({
      database,
      workspaceRoot: "/workspace-b",
    })

    await workspaceA.add({
      toolName: "shell",
      pattern: "git status",
    })

    expect(
      await workspaceA.isAllowed({
        toolName: "shell",
        reason: "shell git status",
      }),
    ).toBe(true)
    expect(
      await workspaceB.isAllowed({
        toolName: "shell",
        reason: "shell git status",
      }),
    ).toBe(false)
    expect(await workspaceA.list()).toHaveLength(1)
    expect(await workspaceB.list()).toEqual([])
  })

  test("matches workspace-relative write paths with glob patterns", async () => {
    const database = trackDatabase(openSessionDatabase(createDatabasePath("allowlist-glob")))
    const store = createPermissionAllowlistStore({
      database,
      workspaceRoot: "/workspace-a",
    })

    await store.add({
      toolName: "write",
      pattern: "**/*.test.ts",
    })

    expect(
      await store.isAllowed({
        toolName: "write",
        reason: "write src/unit/foo.test.ts",
      }),
    ).toBe(true)
    expect(
      await store.isAllowed({
        toolName: "write",
        reason: "write /workspace-a/src/unit/foo.test.ts",
      }),
    ).toBe(true)
    expect(
      await store.isAllowed({
        toolName: "write",
        reason: "write src/unit/foo.ts",
      }),
    ).toBe(false)
  })

  test("does not allow path matches outside the current workspace scope", async () => {
    const database = trackDatabase(openSessionDatabase(createDatabasePath("allowlist-scope")))
    const store = createPermissionAllowlistStore({
      database,
      workspaceRoot: "/workspace-a",
    })

    await store.add({
      toolName: "write",
      pattern: "*.test.ts",
    })

    expect(
      await store.isAllowed({
        toolName: "write",
        reason: "write ../outside/foo.test.ts",
      }),
    ).toBe(false)
    expect(
      await store.isAllowed({
        toolName: "edit",
        reason: "edit /tmp/foo.test.ts",
      }),
    ).toBe(false)
  })

  test("matches shell commands exactly rather than by prefix", async () => {
    const database = trackDatabase(openSessionDatabase(createDatabasePath("allowlist-exact-shell")))
    const store = createPermissionAllowlistStore({
      database,
      workspaceRoot: "/workspace-a",
    })

    await store.add({
      toolName: "shell",
      pattern: "git status",
    })

    expect(
      await store.isAllowed({
        toolName: "shell",
        reason: "shell git status",
      }),
    ).toBe(true)
    expect(
      await store.isAllowed({
        toolName: "shell",
        reason: "shell git status --short",
      }),
    ).toBe(false)
  })

  test("migrates schema-9 databases by creating the allowlist table", async () => {
    const databasePath = createDatabasePath("allowlist-backfill")
    createSchema9Database(databasePath)

    const reopened = trackDatabase(openSessionDatabase(databasePath))
    const store = createPermissionAllowlistStore({
      database: reopened,
      workspaceRoot: "/workspace-a",
    })

    await store.add({
      toolName: "shell",
      pattern: "git status",
    })

    expect(
      await store.isAllowed({
        toolName: "shell",
        reason: "shell git status",
      }),
    ).toBe(true)
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

function createSchema9Database(filePath: string) {
  const database = new Database(filePath, { create: true, strict: true })

  try {
    database.exec("PRAGMA foreign_keys = ON")
    database.exec("PRAGMA journal_mode = WAL")
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT 'New session',
        updated_at INTEGER NOT NULL DEFAULT 0,
        latest_user_message_preview TEXT,
        active_skills_json TEXT NOT NULL DEFAULT '[]',
        parent_session_id TEXT REFERENCES session(id) ON DELETE CASCADE
      )
    `)
    database.exec(`
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
      )
    `)
    database.exec(`
      CREATE UNIQUE INDEX run_session_sequence_idx
      ON run (session_id, session_sequence)
      WHERE session_sequence >= 0
    `)
    database.exec(`
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
    `)
    database.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'compaction')),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
        UNIQUE (id, run_id, session_id),
        UNIQUE (run_id, sequence)
      )
    `)
    database.exec(`
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
      )
    `)
    database.exec(`
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
      )
    `)
    database.exec("PRAGMA user_version = 9")
  } finally {
    database.close(false)
  }
}
