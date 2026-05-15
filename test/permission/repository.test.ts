import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionRepository,
  openSessionDatabase,
} from "../../src/session"
import {
  PermissionNotFoundError,
  createPermissionRepository,
} from "../../src/permission"

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

describe("permission repository", () => {
  test("creates, lists, and updates persisted permission requests", () => {
    const { conversationRepository, permissionRepository } = createTestSubject("persisted-requests")

    conversationRepository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    conversationRepository.runs.create({
      id: "run_1",
      sessionId: "session_1",
      trigger: "cli",
      status: "running",
      createdAt: 2,
      startedAt: 3,
    })

    permissionRepository.requests.create({
      id: "permission_2",
      sessionId: "session_1",
      runId: "run_1",
      toolName: "write",
      reason: "write notes.txt",
      createdAt: 20,
    })
    permissionRepository.requests.create({
      id: "permission_1",
      sessionId: "session_1",
      runId: "run_1",
      toolName: "shell",
      reason: "run git status",
      createdAt: 10,
    })

    expect(permissionRepository.requests.listByRun("run_1")).toMatchObject([
      {
        id: "permission_1",
        toolName: "shell",
        status: "pending",
        resolvedAt: null,
      },
      {
        id: "permission_2",
        toolName: "write",
        status: "pending",
        resolvedAt: null,
      },
    ])

    const updated = permissionRepository.requests.updateStatus({
      requestId: "permission_1",
      status: "approved",
      resolvedAt: 30,
    })

    expect(updated).toMatchObject({
      id: "permission_1",
      status: "approved",
      resolvedAt: 30,
    })
    expect(permissionRepository.requests.get("permission_1")).toMatchObject({
      id: "permission_1",
      status: "approved",
      resolvedAt: 30,
    })
  })

  test("preserves creation order for auto-timestamped pending requests created in the same tick", () => {
    const { conversationRepository, permissionRepository } = createTestSubject(
      "same-tick-order",
      {
        now: () => 100,
        createId: (() => {
          const ids = ["permission_b", "permission_a"]
          return () => ids.shift() ?? "permission_extra"
        })(),
      },
    )

    conversationRepository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    conversationRepository.runs.create({
      id: "run_1",
      sessionId: "session_1",
      trigger: "cli",
      status: "running",
      createdAt: 2,
      startedAt: 3,
    })

    permissionRepository.requests.create({
      sessionId: "session_1",
      runId: "run_1",
      toolName: "webfetch",
      reason: "webfetch data:text/plain,second",
    })
    permissionRepository.requests.create({
      sessionId: "session_1",
      runId: "run_1",
      toolName: "webfetch",
      reason: "webfetch data:text/plain,first",
    })

    expect(
      permissionRepository.requests.listByRun("run_1").map((request) => request.reason),
    ).toEqual([
      "webfetch data:text/plain,second",
      "webfetch data:text/plain,first",
    ])
  })

  test("surfaces explicit not-found errors for reads and updates", () => {
    const { permissionRepository } = createTestSubject("not-found")

    expect(() => permissionRepository.requests.get("permission_missing")).toThrow(
      PermissionNotFoundError,
    )
    expect(() =>
      permissionRepository.requests.updateStatus({
        requestId: "permission_missing",
        status: "approved",
      }),
    ).toThrow(PermissionNotFoundError)
  })
})

function createTestSubject(
  prefix: string,
  options: Omit<Parameters<typeof createPermissionRepository>[0], "database"> = {},
) {
  const database = openSessionDatabase(createDatabasePath(prefix))
  trackDatabase(database)

  return {
    conversationRepository: createSessionRepository({ database }),
    permissionRepository: createPermissionRepository({ database, ...options }),
  }
}

function createDatabasePath(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `neo-coworker-${prefix}-`))
  tempDirectories.push(directory)
  return join(directory, "agent.sqlite")
}

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}
