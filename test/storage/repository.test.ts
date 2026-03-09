import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  StorageNotFoundError,
  StorageOwnershipError,
  createStorageRepository,
  openStorageDatabase,
} from "../../src/storage"

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

describe("storage repository", () => {
  test("rolls back createRunWithInitiatingMessage when the message insert fails", () => {
    const { database, repository } = createTestRepository("run-message-rollback")

    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    const existingRun = repository.runs.create({
      id: "run_existing",
      sessionId: session.id,
      trigger: "cli",
      status: "completed",
      createdAt: 2,
    })
    repository.messages.create({
      id: "message_duplicate",
      sessionId: session.id,
      runId: existingRun.id,
      role: "user",
      sequence: 0,
      createdAt: 3,
    })

    expect(() =>
      repository.createRunWithInitiatingMessage({
        run: {
          id: "run_pending",
          sessionId: session.id,
          trigger: "cli",
          status: "queued",
          createdAt: 4,
        },
        message: {
          id: "message_duplicate",
          sequence: 0,
          createdAt: 5,
        },
      }),
    ).toThrow(/UNIQUE|constraint/i)

    expect(() => repository.runs.get("run_pending")).toThrow(StorageNotFoundError)
    expect(countRows(database, "run")).toBe(1)
    expect(countRows(database, "message")).toBe(1)
  })

  test("returns session transcript with stable message and part ordering", () => {
    const { repository } = createTestRepository("transcript-ordering")

    repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    repository.runs.create({
      id: "run_2",
      sessionId: "session_1",
      trigger: "cli",
      status: "completed",
      createdAt: 20,
    })
    repository.runs.create({
      id: "run_1",
      sessionId: "session_1",
      trigger: "cli",
      status: "completed",
      createdAt: 10,
    })

    repository.messages.create({
      id: "message_2",
      sessionId: "session_1",
      runId: "run_1",
      role: "assistant",
      sequence: 1,
      createdAt: 13,
    })
    repository.messages.create({
      id: "message_0",
      sessionId: "session_1",
      runId: "run_1",
      role: "user",
      sequence: 0,
      createdAt: 12,
    })
    repository.messages.create({
      id: "message_3",
      sessionId: "session_1",
      runId: "run_2",
      role: "user",
      sequence: 0,
      createdAt: 21,
    })

    repository.parts.create({
      id: "part_2",
      sessionId: "session_1",
      runId: "run_1",
      messageId: "message_2",
      kind: "text",
      sequence: 2,
      text: "third",
      createdAt: 16,
    })
    repository.parts.create({
      id: "part_0",
      sessionId: "session_1",
      runId: "run_1",
      messageId: "message_2",
      kind: "step_start",
      sequence: 0,
      text: "first",
      createdAt: 14,
    })
    repository.parts.create({
      id: "part_1",
      sessionId: "session_1",
      runId: "run_1",
      messageId: "message_2",
      kind: "text",
      sequence: 1,
      text: "second",
      createdAt: 15,
    })

    const transcript = repository.messages.listSessionTranscript("session_1")

    expect(transcript.map((message) => message.id)).toEqual(["message_0", "message_2", "message_3"])
    expect(transcript[1]?.parts.map((part) => part.id)).toEqual(["part_0", "part_1", "part_2"])
  })

  test("rejects mismatched parent ownership", () => {
    const { repository } = createTestRepository("ownership-mismatch")

    repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    repository.runs.create({
      id: "run_1",
      sessionId: "session_1",
      trigger: "cli",
      status: "running",
      createdAt: 2,
    })
    repository.runs.create({
      id: "run_2",
      sessionId: "session_1",
      trigger: "cli",
      status: "running",
      createdAt: 3,
    })
    repository.messages.create({
      id: "message_1",
      sessionId: "session_1",
      runId: "run_1",
      role: "assistant",
      sequence: 0,
      createdAt: 4,
    })

    expect(() =>
      repository.parts.create({
        id: "part_bad",
        sessionId: "session_1",
        runId: "run_2",
        messageId: "message_1",
        kind: "text",
        sequence: 0,
        text: "bad",
        createdAt: 5,
      }),
    ).toThrow(StorageOwnershipError)
  })

  test("rolls back run status when requestPermissionAndPauseRun fails", () => {
    const { database, repository } = createTestRepository("permission-rollback")

    repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    repository.runs.create({
      id: "run_1",
      sessionId: "session_1",
      trigger: "cli",
      status: "running",
      createdAt: 2,
      startedAt: 3,
    })
    repository.permissionRequests.create({
      id: "permission_duplicate",
      sessionId: "session_1",
      runId: "run_1",
      toolName: "shell",
      reason: "existing request",
      status: "pending",
      createdAt: 4,
    })

    expect(() =>
      repository.requestPermissionAndPauseRun({
        runId: "run_1",
        permissionRequest: {
          id: "permission_duplicate",
          toolName: "shell",
          reason: "Need to run git status",
          createdAt: 5,
        },
      }),
    ).toThrow(/UNIQUE|constraint/i)

    expect(repository.runs.get("run_1").status).toBe("running")
    expect(countRows(database, "permission_request")).toBe(1)
  })

  test("surfaces explicit not-found errors for reads and updates", () => {
    const { repository } = createTestRepository("not-found")

    expect(() => repository.sessions.get("session_missing")).toThrow(StorageNotFoundError)
    expect(() =>
      repository.runs.updateStatus({
        runId: "run_missing",
        status: "completed",
      }),
    ).toThrow(StorageNotFoundError)
    expect(() =>
      repository.parts.updateContent({
        partId: "part_missing",
        text: "hello",
      }),
    ).toThrow(StorageNotFoundError)
  })

  test("updates part content incrementally without rewriting other transcript rows", () => {
    const { repository } = createTestRepository("part-incremental")

    repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    repository.runs.create({
      id: "run_1",
      sessionId: "session_1",
      trigger: "cli",
      status: "running",
      createdAt: 2,
    })

    const { message, part } = repository.createAssistantMessageWithFirstPart({
      message: {
        id: "message_1",
        sessionId: "session_1",
        runId: "run_1",
        sequence: 0,
        createdAt: 3,
      },
      part: {
        id: "part_1",
        kind: "text",
        sequence: 0,
        text: "Hel",
        createdAt: 4,
      },
    })

    const updatedPart = repository.parts.updateContent({
      partId: part.id,
      text: "Hello",
      data: { complete: true },
    })
    const transcript = repository.messages.listSessionTranscript("session_1")

    expect(message.role).toBe("assistant")
    expect(updatedPart).toMatchObject({
      id: "part_1",
      text: "Hello",
      data: { complete: true },
    })
    expect(transcript).toEqual([
      {
        ...message,
        parts: [
          {
            ...updatedPart,
          },
        ],
      },
    ])
  })
})

function createTestRepository(prefix: string) {
  const database = openStorageDatabase(createDatabasePath(prefix))
  trackDatabase(database)

  return {
    database,
    repository: createStorageRepository({ database }),
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

function countRows(database: { query: (sql: string) => { get: () => unknown } }, table: string) {
  const row = database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  return row.count
}
