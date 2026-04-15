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
    const seeded = trackDatabase(openSessionDatabase(databasePath))

    seeded.exec("DROP TABLE permission_allowlist")
    seeded.exec("PRAGMA user_version = 9")
    seeded.close(false)
    openDatabases.pop()

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
