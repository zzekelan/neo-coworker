import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
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

  test("stores parentSessionId and lists sub-sessions separately from top-level sessions", () => {
    const { repository } = createTestRepository("sub-session-crud")

    const parentA = repository.sessions.create({
      id: "session_parent_a",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
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

    expect(childA.parentSessionId).toBe(parentA.id)
    expect(repository.sessions.get(childA.id)).toMatchObject({
      id: childA.id,
      parentSessionId: parentA.id,
    })
    expect(repository.sessions.listSubSessions(parentA.id).map((session) => session.id)).toEqual([
      "session_child_a",
      "session_child_b",
    ])
    expect(repository.sessions.listTopLevel().map((session) => session.id)).toEqual([
      "session_parent_a",
      "session_parent_b",
    ])
    expect(repository.sessions.listTopLevel()).toEqual([
      expect.objectContaining({ id: parentA.id, parentSessionId: undefined }),
      expect.objectContaining({ id: parentB.id, parentSessionId: undefined }),
    ])
    expect(repository.sessions.listSubSessions(parentA.id)).toEqual([
      expect.objectContaining({ id: childA.id, parentSessionId: parentA.id }),
      expect.objectContaining({ id: childB.id, parentSessionId: parentA.id }),
    ])
  })

  test("creates a sub-session with its queued run and initiating transcript atomically", () => {
    const { repository } = createTestRepository("sub-session-atomic-create")

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
    })
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
