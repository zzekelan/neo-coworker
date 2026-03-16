import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ConversationNotFoundError as StorageNotFoundError,
  ConversationOwnershipError as StorageOwnershipError,
  createConversationRepository as createStorageRepository,
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

describe("storage repository", () => {
  test("rolls back createQueuedRunWithInitiatingMessage when the message insert fails", () => {
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
      repository.createQueuedRunWithInitiatingMessage({
        run: {
          id: "run_pending",
          sessionId: session.id,
          trigger: "cli",
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

  test("rolls back createQueuedRunWithInitiatingMessageAndPart when the part insert fails", () => {
    const { database, repository } = createTestRepository("run-message-part-rollback")

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
    const existingMessage = repository.messages.create({
      id: "message_existing",
      sessionId: session.id,
      runId: existingRun.id,
      role: "user",
      sequence: 0,
      createdAt: 3,
    })
    repository.parts.create({
      id: "part_duplicate",
      sessionId: session.id,
      runId: existingRun.id,
      messageId: existingMessage.id,
      kind: "text",
      sequence: 0,
      text: "existing",
      createdAt: 4,
    })

    expect(() =>
      repository.createQueuedRunWithInitiatingMessageAndPart({
        run: {
          id: "run_pending",
          sessionId: session.id,
          trigger: "cli",
          createdAt: 5,
        },
        message: {
          id: "message_pending",
          sequence: 0,
          createdAt: 6,
        },
        part: {
          id: "part_duplicate",
          kind: "text",
          sequence: 0,
          text: "prompt",
          createdAt: 7,
        },
      }),
    ).toThrow(/UNIQUE|constraint/i)

    expect(() => repository.runs.get("run_pending")).toThrow(StorageNotFoundError)
    expect(() => repository.messages.get("message_pending")).toThrow(StorageNotFoundError)
    expect(countRows(database, "run")).toBe(1)
    expect(countRows(database, "message")).toBe(1)
    expect(countRows(database, "part")).toBe(1)
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

  test("preserves insertion order for runs that share the same createdAt millisecond", () => {
    const { repository } = createTestRepository("same-created-at-ordering")

    repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    repository.runs.create({
      id: "run_b",
      sessionId: "session_1",
      trigger: "cli",
      status: "completed",
      createdAt: 10,
    })
    repository.messages.create({
      id: "message_b",
      sessionId: "session_1",
      runId: "run_b",
      role: "user",
      sequence: 0,
      createdAt: 10,
    })
    repository.parts.create({
      id: "part_b",
      sessionId: "session_1",
      runId: "run_b",
      messageId: "message_b",
      kind: "text",
      sequence: 0,
      text: "first inserted",
      createdAt: 10,
    })

    repository.runs.create({
      id: "run_a",
      sessionId: "session_1",
      trigger: "cli",
      status: "completed",
      createdAt: 10,
    })
    repository.messages.create({
      id: "message_a",
      sessionId: "session_1",
      runId: "run_a",
      role: "user",
      sequence: 0,
      createdAt: 10,
    })
    repository.parts.create({
      id: "part_a",
      sessionId: "session_1",
      runId: "run_a",
      messageId: "message_a",
      kind: "text",
      sequence: 0,
      text: "second inserted",
      createdAt: 10,
    })

    expect(repository.runs.listBySession("session_1").map((run) => run.id)).toEqual([
      "run_b",
      "run_a",
    ])
    expect(repository.runs.getLatestBySession("session_1")?.id).toBe("run_a")
    expect(
      repository
        .messages
        .listSessionTranscript("session_1")
        .map((message) => `${message.runId}:${message.parts[0]?.text}`),
    ).toEqual(["run_b:first inserted", "run_a:second inserted"])
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

  test("surfaces explicit not-found errors for reads and updates", () => {
    const { repository } = createTestRepository("not-found")

    expect(() => repository.sessions.get("session_missing")).toThrow(StorageNotFoundError)
    expect(() => repository.messages.get("message_missing")).toThrow(StorageNotFoundError)
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

  test("rolls back createAssistantMessageWithFirstPart when the part insert fails", () => {
    const { database, repository } = createTestRepository("assistant-message-rollback")

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
    repository.messages.create({
      id: "message_existing",
      sessionId: "session_1",
      runId: "run_1",
      role: "assistant",
      sequence: 0,
      createdAt: 3,
    })
    repository.parts.create({
      id: "part_duplicate",
      sessionId: "session_1",
      runId: "run_1",
      messageId: "message_existing",
      kind: "text",
      sequence: 0,
      text: "existing",
      createdAt: 4,
    })

    expect(() =>
      repository.createAssistantMessageWithFirstPart({
        message: {
          id: "message_pending",
          sessionId: "session_1",
          runId: "run_1",
          sequence: 1,
          createdAt: 5,
        },
        part: {
          id: "part_duplicate",
          kind: "text",
          sequence: 0,
          text: "new",
          createdAt: 6,
        },
      }),
    ).toThrow(/UNIQUE|constraint/i)

    expect(() => repository.messages.get("message_pending")).toThrow(StorageNotFoundError)
    expect(countRows(database, "message")).toBe(1)
    expect(countRows(database, "part")).toBe(1)
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
