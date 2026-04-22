// @ts-expect-error Bun runtime module is provided by Bun.
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildTranscriptMessages } from "../../src/model"
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  SessionConflictError,
  SessionNotFoundError as StorageNotFoundError,
  SessionOwnershipError as StorageOwnershipError,
  createSessionRepository as createStorageRepository,
  openSessionDatabase as openStorageDatabase,
} from "../../src/session"

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
  test("uses schema version 11 for agent tracking columns", () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(11)
  })

  test("creates fresh databases with default top-level current agent and persists message agents", () => {
    const databasePath = createDatabasePath("schema-v11-fresh")
    const database = openStorageDatabase(databasePath)
    trackDatabase(database)

    expect(listTableColumns(database, "session")).toContain("current_agent")
    expect(listTableColumns(database, "message")).toContain("agent")

    const repository = createStorageRepository({ database })
    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    const run = repository.runs.create({
      id: "run_1",
      sessionId: session.id,
      trigger: "cli",
      status: "completed",
      createdAt: 2,
    })
    const message = repository.messages.create({
      id: "message_1",
      sessionId: session.id,
      runId: run.id,
      agent: session.currentAgent,
      role: "user",
      sequence: 0,
      createdAt: 3,
    })

    const rawSession = database
      .query("SELECT current_agent FROM session WHERE id = ?")
      .get(session.id) as { current_agent: string | null }
    const rawMessage = database
      .query("SELECT agent FROM message WHERE id = ?")
      .get(message.id) as { agent: string | null }

    expect(rawSession.current_agent).toBe("default")
    expect(rawMessage.agent).toBe("default")
    expect(repository.sessions.get(session.id).currentAgent).toBe("default")
    expect(repository.sessions.getCurrentAgent(session.id)).toBe("default")
    expect(repository.messages.get(message.id).agent).toBe("default")

    repository.sessions.setCurrentAgent(session.id, "plan")
    const secondMessage = repository.messages.create({
      id: "message_2",
      sessionId: session.id,
      runId: run.id,
      agent: repository.sessions.getCurrentAgent(session.id),
      role: "assistant",
      sequence: 1,
      createdAt: 4,
    })

    expect(rawSessionValue(database, session.id)).toBe("plan")
    expect(repository.sessions.get(session.id).currentAgent).toBe("plan")
    expect(repository.sessions.getCurrentAgent(session.id)).toBe("plan")
    expect(repository.messages.get(message.id).agent).toBe("default")
    expect(repository.messages.get(secondMessage.id).agent).toBe("plan")
    expect(repository.messages.listSessionTranscript(session.id)).toEqual([
      expect.objectContaining({ id: message.id, agent: "default" }),
      expect.objectContaining({ id: secondMessage.id, agent: "plan" }),
    ])
  })

  test("migrates existing v10 databases to v11 without data loss", () => {
    const databasePath = createDatabasePath("schema-v10-migration")
    createVersion10Database(databasePath)

    const database = openStorageDatabase(databasePath)
    trackDatabase(database)
    const repository = createStorageRepository({ database })

    expect(listTableColumns(database, "session")).toContain("current_agent")
    expect(listTableColumns(database, "message")).toContain("agent")
    expect(getUserVersion(database)).toBe(11)

    const rawSession = database.query("SELECT * FROM session WHERE id = ?").get("session_1") as {
      directory: string
      workspace_root: string
      created_at: number
      current_agent: string | null
      title: string
      updated_at: number
      latest_user_message_preview: string | null
      active_skills_json: string
      parent_session_id: string | null
    }
    const rawMessage = database.query("SELECT * FROM message WHERE id = ?").get("message_1") as {
      session_id: string
      run_id: string
      role: string
      sequence: number
      created_at: number
      agent: string | null
    }

    expect(rawSession).toMatchObject({
      directory: "/workspace",
      workspace_root: "/workspace",
      created_at: 1,
      current_agent: null,
      title: "Migrated session",
      updated_at: 2,
      latest_user_message_preview: "existing preview",
      active_skills_json: '["reviewer"]',
      parent_session_id: null,
    })
    expect(rawMessage).toMatchObject({
      session_id: "session_1",
      run_id: "run_1",
      role: "user",
      sequence: 0,
      created_at: 4,
      agent: null,
    })
    expect(repository.sessions.get("session_1")).toMatchObject({
      id: "session_1",
      currentAgent: "default",
      title: "Migrated session",
      activeSkills: ["reviewer"],
    })
    expect(repository.sessions.getCurrentAgent("session_1")).toBe("default")
    expect(repository.messages.get("message_1")).toMatchObject({
      id: "message_1",
      agent: undefined,
      runId: "run_1",
      role: "user",
    })
  })

  test("surfaces undefined transcript agents for legacy null message rows", () => {
    const { database, repository } = createTestRepository("legacy-null-message-agent")

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
      status: "completed",
      createdAt: 2,
    })

    database
      .query(
        "INSERT INTO message (id, session_id, run_id, agent, role, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("message_legacy", "session_1", "run_1", null, "user", 0, 3)

    expect(repository.messages.get("message_legacy")).toMatchObject({
      id: "message_legacy",
      agent: undefined,
    })
    expect(repository.messages.listSessionTranscript("session_1")).toEqual([
      expect.objectContaining({
        id: "message_legacy",
        agent: undefined,
      }),
    ])
  })

  test("restores persisted current agent from reopened storage", () => {
    const databasePath = createDatabasePath("session-current-agent-restore")
    const initialDatabase = openStorageDatabase(databasePath)
    trackDatabase(initialDatabase)

    const initialRepository = createStorageRepository({ database: initialDatabase })
    const session = initialRepository.sessions.create({
      id: "session_restore",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    initialRepository.sessions.setCurrentAgent(session.id, "plan")

    openDatabases.pop()?.close(false)

    const reopenedDatabase = openStorageDatabase(databasePath)
    trackDatabase(reopenedDatabase)

    const reopenedRepository = createStorageRepository({ database: reopenedDatabase })

    expect(reopenedRepository.sessions.get(session.id).currentAgent).toBe("plan")
    expect(reopenedRepository.sessions.getCurrentAgent(session.id)).toBe("plan")
  })

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

  test("allows explicitly concurrent queued runs for internal sub-agent execution", () => {
    const { repository } = createTestRepository("concurrent-sub-agent-run")

    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    repository.runs.create({
      id: "run_parent",
      sessionId: session.id,
      trigger: "prompt",
      status: "running",
      createdAt: 2,
    })

    expect(() =>
      repository.createQueuedRunWithInitiatingMessageAndPart({
        run: {
          id: "run_rejected",
          sessionId: session.id,
          trigger: "prompt",
          createdAt: 3,
        },
        message: {
          id: "message_rejected",
          sequence: 0,
          createdAt: 3,
        },
        part: {
          id: "part_rejected",
          kind: "text",
          sequence: 0,
          text: "sub-agent prompt",
          createdAt: 3,
        },
      }),
    ).toThrow(SessionConflictError)

    const created = repository.createQueuedRunWithInitiatingMessageAndPart({
      run: {
        id: "run_child",
        sessionId: session.id,
        trigger: "prompt",
        createdAt: 4,
      },
      message: {
        id: "message_child",
        sequence: 0,
        createdAt: 4,
      },
      part: {
        id: "part_child",
        kind: "text",
        sequence: 0,
        text: "sub-agent prompt",
        createdAt: 4,
      },
      allowConcurrentActiveRun: true,
    })

    expect(created.run).toMatchObject({
      id: "run_child",
      status: "queued",
    })
    expect(created.message).toMatchObject({
      id: "message_child",
      runId: "run_child",
    })
    expect(created.part).toMatchObject({
      id: "part_child",
      runId: "run_child",
      text: "sub-agent prompt",
    })
  })

  test("lists top-level sessions by updatedAt desc, keeps list() unchanged, and filters direct sub-sessions by parent", () => {
    const { repository } = createTestRepository("sub-session-crud")

    const parentA = repository.sessions.create({
      id: "session_parent_a",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
      updatedAt: 20,
    })
    const childA = repository.sessions.create({
      id: "session_child_a",
      directory: "/workspace/sub-a",
      workspaceRoot: "/workspace",
      createdAt: 2,
      parentSessionId: parentA.id,
    })
    const parentB = repository.sessions.create({
      id: "session_parent_b",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 3,
      updatedAt: 40,
    })
    const childB = repository.sessions.create({
      id: "session_child_b",
      directory: "/workspace/sub-b",
      workspaceRoot: "/workspace",
      createdAt: 4,
      parentSessionId: parentA.id,
    })
    repository.sessions.create({
      id: "session_other_child",
      directory: "/workspace/sub-c",
      workspaceRoot: "/workspace",
      createdAt: 5,
      parentSessionId: parentB.id,
    })
    repository.sessions.create({
      id: "session_grandchild",
      directory: "/workspace/sub-a/grandchild",
      workspaceRoot: "/workspace",
      createdAt: 6,
      parentSessionId: childA.id,
    })

    expect(childA.parentSessionId).toBe(parentA.id)
    expect(repository.sessions.get(childA.id)).toMatchObject({
      id: childA.id,
      parentSessionId: parentA.id,
    })
    expect(repository.sessions.listSubSessions(parentA.id).map((session) => session.id)).toEqual([
      "session_child_a",
      "session_child_b",
    ])
    expect(repository.sessions.listSubSessions(parentB.id).map((session) => session.id)).toEqual([
      "session_other_child",
    ])
    expect(repository.sessions.listTopLevel().map((session) => session.id)).toEqual([
      "session_parent_b",
      "session_parent_a",
    ])
    expect(repository.sessions.list().map((session) => session.id)).toEqual([
      "session_parent_a",
      "session_child_a",
      "session_parent_b",
      "session_child_b",
      "session_other_child",
      "session_grandchild",
    ])
    expect(repository.sessions.listTopLevel()).toEqual([
      expect.objectContaining({ id: parentB.id, parentSessionId: undefined }),
      expect.objectContaining({ id: parentA.id, parentSessionId: undefined }),
    ])
    expect(repository.sessions.listSubSessions(parentA.id)).toEqual([
      expect.objectContaining({ id: childA.id, parentSessionId: parentA.id }),
      expect.objectContaining({ id: childB.id, parentSessionId: parentA.id }),
    ])
  })

  test("listTopLevel returns all sessions when no sub-sessions exist and listSubSessions returns an empty array", () => {
    const { repository } = createTestRepository("sub-session-listing-edge")

    const sessionA = repository.sessions.create({
      id: "session_a",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
      updatedAt: 10,
    })
    const sessionB = repository.sessions.create({
      id: "session_b",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 2,
      updatedAt: 30,
    })
    const sessionC = repository.sessions.create({
      id: "session_c",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 3,
      updatedAt: 20,
    })

    expect(repository.sessions.listTopLevel().map((session) => session.id)).toEqual([
      "session_b",
      "session_c",
      "session_a",
    ])
    expect(repository.sessions.listTopLevel()).toEqual([
      expect.objectContaining({ id: sessionB.id, parentSessionId: undefined }),
      expect.objectContaining({ id: sessionC.id, parentSessionId: undefined }),
      expect.objectContaining({ id: sessionA.id, parentSessionId: undefined }),
    ])
    expect(repository.sessions.list().map((session) => session.id)).toEqual([
      "session_a",
      "session_b",
      "session_c",
    ])
    expect(repository.sessions.listSubSessions(sessionA.id)).toEqual([])
  })

  test("creates a sub-session with its queued run and initiating transcript atomically", () => {
    const { database, repository } = createTestRepository("sub-session-atomic-create")

    const parent = repository.sessions.create({
      id: "session_parent",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    const created = repository.createSubSessionWithRun({
      session: {
        id: "session_child",
        directory: "/workspace/sub-agent",
        workspaceRoot: "/workspace",
        createdAt: 2,
        parentSessionId: parent.id,
      },
      run: {
        id: "run_child",
        trigger: "prompt",
        createdAt: 3,
        activeSkills: [" reviewer ", "reviewer", "writer"],
        parentRunId: "run_parent",
      },
      message: {
        id: "message_child",
        sequence: 0,
        createdAt: 4,
      },
      part: {
        id: "part_child",
        kind: "text",
        sequence: 0,
        text: "Investigate why the child transcript leaked into the parent.",
        createdAt: 5,
      },
    })

    expect(created.session).toMatchObject({
      id: "session_child",
      parentSessionId: parent.id,
      currentAgent: undefined,
    })
    expect(created.run).toMatchObject({
      id: "run_child",
      sessionId: "session_child",
      status: "queued",
      activeSkills: ["reviewer", "writer"],
      parentRunId: "run_parent",
    })
    expect(repository.sessions.get("session_child")).toMatchObject({
      parentSessionId: parent.id,
      currentAgent: undefined,
    })
    expect(repository.sessions.getCurrentAgent("session_child")).toBeUndefined()
    expect(rawSessionValue(database, "session_child")).toBeNull()
    expect(repository.runs.get("run_child")).toMatchObject({
      sessionId: "session_child",
      status: "queued",
      parentRunId: "run_parent",
    })
    expect(repository.messages.listSessionTranscript("session_child")).toEqual([
      {
        id: "message_child",
        sessionId: "session_child",
        runId: "run_child",
        role: "user",
        sequence: 0,
        createdAt: 4,
        parts: [
          {
            id: "part_child",
            sessionId: "session_child",
            runId: "run_child",
            messageId: "message_child",
            kind: "text",
            sequence: 0,
            text: "Investigate why the child transcript leaked into the parent.",
            data: null,
            createdAt: 5,
          },
        ],
      },
    ])
  })

  test("rolls back createSubSessionWithRun when run creation fails", () => {
    const { database, repository } = createTestRepository("sub-session-atomic-rollback")

    const parent = repository.sessions.create({
      id: "session_parent",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    repository.runs.create({
      id: "run_duplicate",
      sessionId: parent.id,
      trigger: "cli",
      status: "completed",
      createdAt: 2,
    })

    expect(() =>
      repository.createSubSessionWithRun({
        session: {
          id: "session_child",
          directory: "/workspace/sub-agent",
          workspaceRoot: "/workspace",
          createdAt: 3,
          parentSessionId: parent.id,
        },
        run: {
          id: "run_duplicate",
          trigger: "prompt",
          createdAt: 4,
        },
        message: {
          id: "message_child",
          sequence: 0,
          createdAt: 5,
        },
        part: {
          id: "part_child",
          kind: "text",
          sequence: 0,
          text: "sub-agent prompt",
          createdAt: 6,
        },
      }),
    ).toThrow(/UNIQUE|constraint/i)

    expect(() => repository.sessions.get("session_child")).toThrow(StorageNotFoundError)
    expect(() => repository.messages.get("message_child")).toThrow(StorageNotFoundError)
    expect(countRows(database, "session")).toBe(1)
    expect(countRows(database, "run")).toBe(1)
    expect(countRows(database, "message")).toBe(0)
    expect(countRows(database, "part")).toBe(0)
  })

  test("deleting a parent session cascades to sub-sessions and their transcript rows", () => {
    const { database, repository } = createTestRepository("sub-session-cascade")

    const parent = repository.sessions.create({
      id: "session_parent",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    repository.createSubSessionWithRun({
      session: {
        id: "session_child",
        directory: "/workspace/sub-agent",
        workspaceRoot: "/workspace",
        createdAt: 2,
        parentSessionId: parent.id,
      },
      run: {
        id: "run_child",
        trigger: "prompt",
        createdAt: 3,
      },
      message: {
        id: "message_child",
        sequence: 0,
        createdAt: 4,
      },
      part: {
        id: "part_child",
        kind: "text",
        sequence: 0,
        text: "sub-agent prompt",
        createdAt: 5,
      },
    })

    database.query("DELETE FROM session WHERE id = ?").run(parent.id)

    expect(() => repository.sessions.get("session_parent")).toThrow(StorageNotFoundError)
    expect(() => repository.sessions.get("session_child")).toThrow(StorageNotFoundError)
    expect(countRows(database, "session")).toBe(0)
    expect(countRows(database, "run")).toBe(0)
    expect(countRows(database, "message")).toBe(0)
    expect(countRows(database, "part")).toBe(0)
  })

  test("keeps transcripts isolated between parent sessions and sub-sessions", () => {
    const { repository } = createTestRepository("sub-session-transcript-isolation")

    const parent = repository.sessions.create({
      id: "session_parent",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    repository.createQueuedRunWithInitiatingMessageAndPart({
      run: {
        id: "run_parent",
        sessionId: parent.id,
        trigger: "prompt",
        createdAt: 2,
      },
      message: {
        id: "message_parent",
        sequence: 0,
        createdAt: 3,
      },
      part: {
        id: "part_parent",
        kind: "text",
        sequence: 0,
        text: "parent prompt",
        createdAt: 4,
      },
    })

    repository.createSubSessionWithRun({
      session: {
        id: "session_child",
        directory: "/workspace/sub-agent",
        workspaceRoot: "/workspace",
        createdAt: 5,
        parentSessionId: parent.id,
      },
      run: {
        id: "run_child",
        trigger: "prompt",
        createdAt: 6,
      },
      message: {
        id: "message_child",
        sequence: 0,
        createdAt: 7,
      },
      part: {
        id: "part_child",
        kind: "text",
        sequence: 0,
        text: "child prompt",
        createdAt: 8,
      },
    })

    expect(repository.messages.listSessionTranscript(parent.id).map((message) => message.id)).toEqual([
      "message_parent",
    ])
    expect(repository.messages.listSessionTranscript(parent.id).map((message) => message.parts[0]?.id)).toEqual([
      "part_parent",
    ])
    expect(repository.messages.listSessionTranscript("session_child").map((message) => message.id)).toEqual([
      "message_child",
    ])
    expect(
      repository
        .messages
        .listSessionTranscript(parent.id)
        .flatMap((message) => [message.id, ...message.parts.map((part) => part.id)]),
    ).not.toContain("message_child")
    expect(
      repository
        .messages
        .listSessionTranscript(parent.id)
        .flatMap((message) => [message.id, ...message.parts.map((part) => part.id)]),
    ).not.toContain("part_child")
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
      agent: "plan",
      role: "assistant",
      sequence: 1,
      createdAt: 13,
    })
    repository.messages.create({
      id: "message_0",
      sessionId: "session_1",
      runId: "run_1",
      agent: "default",
      role: "user",
      sequence: 0,
      createdAt: 12,
    })
    repository.messages.create({
      id: "message_3",
      sessionId: "session_1",
      runId: "run_2",
      agent: "review",
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
    expect(transcript.map((message) => message.agent)).toEqual(["default", "plan", "review"])
    expect(transcript[1]?.parts.map((part) => part.id)).toEqual(["part_0", "part_1", "part_2"])
  })

  test("replays persisted reasoning parts after reopening storage", () => {
    const databasePath = createDatabasePath("reasoning-transcript-fixture")
    const initialDatabase = openStorageDatabase(databasePath)
    trackDatabase(initialDatabase)

    const repository = createStorageRepository({ database: initialDatabase })

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
      status: "completed",
      createdAt: 2,
    })
    const message = repository.messages.create({
      id: "message_1",
      sessionId: "session_1",
      runId: "run_1",
      role: "assistant",
      sequence: 0,
      createdAt: 3,
    })
    repository.parts.create({
      id: "part_reasoning",
      sessionId: "session_1",
      runId: "run_1",
      messageId: message.id,
      kind: "reasoning",
      sequence: 0,
      text: "Need to inspect the README before calling read.",
      createdAt: 4,
    })

    openDatabases.pop()?.close(false)

    const reopenedDatabase = openStorageDatabase(databasePath)
    trackDatabase(reopenedDatabase)
    const reopenedRepository = createStorageRepository({ database: reopenedDatabase })
    const transcript = reopenedRepository.messages.listSessionTranscript("session_1")

    expect(transcript).toEqual([
      {
        id: "message_1",
        sessionId: "session_1",
        runId: "run_1",
        role: "assistant",
        sequence: 0,
        createdAt: 3,
        parts: [
          {
            id: "part_reasoning",
            sessionId: "session_1",
            runId: "run_1",
            messageId: "message_1",
            kind: "reasoning",
            sequence: 0,
            text: "Need to inspect the README before calling read.",
            data: null,
            createdAt: 4,
          },
        ],
      },
    ])
    expect(buildTranscriptMessages(transcript)).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "Need to inspect the README before calling read.",
          },
        ],
      },
    ])
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

  test("persists resume-facing session metadata from user prompts and preserves custom titles", () => {
    const { repository } = createTestRepository("session-metadata")

    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    expect(session).toMatchObject({
      title: "New session",
      updatedAt: 1,
      latestUserMessagePreview: null,
    })

    repository.runs.create({
      id: "run_1",
      sessionId: session.id,
      trigger: "cli",
      status: "completed",
      createdAt: 2,
    })
    repository.messages.create({
      id: "message_1",
      sessionId: session.id,
      runId: "run_1",
      role: "user",
      sequence: 0,
      createdAt: 3,
    })
    repository.parts.create({
      id: "part_1",
      sessionId: session.id,
      runId: "run_1",
      messageId: "message_1",
      kind: "text",
      sequence: 0,
      text: "Investigate failing chat resume flow",
      createdAt: 4,
    })

    expect(repository.sessions.get(session.id)).toMatchObject({
      title: "Investigate failing chat resume flow",
      updatedAt: 4,
      latestUserMessagePreview: "Investigate failing chat resume flow",
    })

    repository.sessions.update({
      sessionId: session.id,
      title: "Manual title",
    })
    repository.runs.create({
      id: "run_2",
      sessionId: session.id,
      trigger: "cli",
      status: "completed",
      createdAt: 5,
    })
    repository.messages.create({
      id: "message_2",
      sessionId: session.id,
      runId: "run_2",
      role: "user",
      sequence: 0,
      createdAt: 6,
    })
    repository.parts.create({
      id: "part_2",
      sessionId: session.id,
      runId: "run_2",
      messageId: "message_2",
      kind: "text",
      sequence: 0,
      text: "Second prompt should only refresh the preview",
      createdAt: 7,
    })

    expect(repository.sessions.get(session.id)).toMatchObject({
      title: "Manual title",
      updatedAt: 7,
      latestUserMessagePreview: "Second prompt should only refresh the preview",
    })
  })

  test("touches session updatedAt when run status changes", () => {
    const { repository } = createTestRepository("session-activity-touch", {
      now: () => 50,
    })

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

    repository.runs.updateStatus({
      runId: "run_1",
      status: "completed",
      finishedAt: 9,
    })

    expect(repository.sessions.get("session_1")).toMatchObject({
      updatedAt: 50,
    })
  })

  test("stores session active skills as a normalized string list", () => {
    const { repository } = createTestRepository("session-active-skills")

    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
      activeSkills: [" reviewer ", "writer", "reviewer", "", "  "],
    })

    expect(session.activeSkills).toEqual(["reviewer", "writer"])
    expect(repository.sessions.get(session.id).activeSkills).toEqual(["reviewer", "writer"])

    const updated = repository.sessions.update({
      sessionId: session.id,
      activeSkills: ["writer", " reviewer ", "designer", "designer"],
    })

    expect(updated.activeSkills).toEqual(["writer", "reviewer", "designer"])
    expect(repository.sessions.get(session.id).activeSkills).toEqual([
      "writer",
      "reviewer",
      "designer",
    ])
  })

  test("stores run active skills as a normalized string list", () => {
    const { repository } = createTestRepository("run-active-skills")

    repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    const run = repository.runs.create({
      id: "run_1",
      sessionId: "session_1",
      trigger: "cli",
      status: "queued",
      createdAt: 2,
      activeSkills: [" reviewer ", "writer", "reviewer", "", "  "],
    })

    expect(run.activeSkills).toEqual(["reviewer", "writer"])
    expect(repository.runs.get(run.id).activeSkills).toEqual(["reviewer", "writer"])
  })

  test("updates run active skills without changing other run fields", () => {
    const { repository } = createTestRepository("run-active-skills-update", {
      now: () => 50,
    })

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

    const updated = repository.runs.addActiveSkills({
      runId: "run_1",
      activeSkills: [" reviewer ", "writer", "reviewer"],
    })

    expect(updated).toMatchObject({
      id: "run_1",
      status: "running",
      startedAt: 3,
      activeSkills: ["reviewer", "writer"],
    })
    expect(repository.sessions.get("session_1")).toMatchObject({
      updatedAt: 50,
    })
  })

  test("updates run token usage without changing other run fields", () => {
    const { repository } = createTestRepository("run-token-usage-update", {
      now: () => 50,
    })

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
      activeSkills: ["reviewer"],
      inputTokens: 7,
      outputTokens: 11,
      tokenUsageSource: "provider",
    })

    const updated = repository.runs.updateTokenUsage({
      runId: "run_1",
      inputTokens: 13,
      outputTokens: 17,
      tokenUsageSource: "estimated",
    })

    expect(updated).toMatchObject({
      id: "run_1",
      status: "running",
      startedAt: 3,
      activeSkills: ["reviewer"],
      inputTokens: 13,
      outputTokens: 17,
      tokenUsageSource: "estimated",
    })
    expect(repository.sessions.get("session_1")).toMatchObject({
      updatedAt: 50,
    })
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
    repository.sessions.setCurrentAgent("session_1", "plan")
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
          agent: "plan",
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
    expect(message.agent).toBe("plan")
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

function createTestRepository(prefix: string, options: { now?: () => number } = {}) {
  const database = openStorageDatabase(createDatabasePath(prefix))
  trackDatabase(database)

  return {
    database,
    repository: createStorageRepository({
      database,
      now: options.now,
    }),
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

function listTableColumns(database: Database, table: string) {
  return (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  )
}

function getUserVersion(database: Database) {
  const row = database.query("PRAGMA user_version").get() as { user_version: number }
  return row.user_version
}

function rawSessionValue(database: Database, sessionId: string) {
  const row = database
    .query("SELECT current_agent FROM session WHERE id = ?")
    .get(sessionId) as { current_agent: string | null }

  return row.current_agent
}

function createVersion10Database(filePath: string) {
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
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        latest_user_message_preview TEXT,
        active_skills_json TEXT NOT NULL DEFAULT '[]',
        parent_session_id TEXT REFERENCES session(id) ON DELETE CASCADE
      )
    `)
    database.exec(`
      CREATE TABLE run (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        session_sequence INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error_text TEXT,
        active_skills_json TEXT NOT NULL DEFAULT '[]',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        token_usage_source TEXT,
        parent_run_id TEXT,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        UNIQUE (id, session_id),
        UNIQUE (session_id, session_sequence)
      )
    `)
    database.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, session_id) REFERENCES run(id, session_id) ON DELETE CASCADE,
        UNIQUE (id, run_id, session_id),
        UNIQUE (run_id, sequence)
      )
    `)
    database.exec(`
      CREATE TABLE permission_allowlist (
        workspace_root TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        pattern TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_root, tool_name, pattern)
      )
    `)

    database
      .query(
        `
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "session_1",
        "/workspace",
        "/workspace",
        1,
        "Migrated session",
        2,
        "existing preview",
        '["reviewer"]',
        null,
      )
    database
      .query(
        `
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "run_1",
        "session_1",
        "cli",
        "completed",
        3,
        0,
        null,
        null,
        null,
        "[]",
        0,
        0,
        null,
        null,
      )
    database
      .query(
        `
          INSERT INTO message (
            id,
            session_id,
            run_id,
            role,
            sequence,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run("message_1", "session_1", "run_1", "user", 0, 4)
    database.exec("PRAGMA user_version = 10")
  } finally {
    database.close(false)
  }
}
