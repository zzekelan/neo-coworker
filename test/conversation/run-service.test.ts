import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  InvalidRunStatusTransitionError,
  RunActiveSkillsUpdateStateError,
  SessionBusyError,
  createSessionRunService,
} from "../../src/session"
import {
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

describe("session run service", () => {
  test("supports the valid run lifecycle and derives session busy or idle state", () => {
    const { repository, service } = createTestSubject("valid-lifecycle", [11, 22])
    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    const created = service.startRun({
      sessionId: session.id,
      runId: "run_1",
      messageId: "message_1",
      createdAt: 2,
      messageCreatedAt: 3,
    })

    expect(created.run).toMatchObject({
      id: "run_1",
      sessionId: session.id,
      trigger: "prompt",
      status: "queued",
      startedAt: null,
      finishedAt: null,
      activeSkills: [],
    })
    expect(created.message).toMatchObject({
      id: "message_1",
      sessionId: session.id,
      runId: "run_1",
      role: "user",
      sequence: 0,
    })
    expect(service.getSessionState(session.id)).toMatchObject({
      status: "busy",
      latestRun: { id: "run_1", status: "queued" },
      activeRun: { id: "run_1", status: "queued" },
    })

    const running = service.transitionRunToRunning("run_1")
    expect(running).toMatchObject({
      id: "run_1",
      status: "running",
      startedAt: 11,
      finishedAt: null,
    })

    const completed = service.completeRun("run_1")
    expect(completed).toMatchObject({
      id: "run_1",
      status: "completed",
      startedAt: 11,
      finishedAt: 22,
      errorText: null,
    })
    expect(service.getSessionState(session.id)).toMatchObject({
      status: "idle",
      latestRun: { id: "run_1", status: "completed" },
      activeRun: null,
    })
  })

  test("rejects illegal run status transitions with explicit errors", () => {
    const { repository, service } = createTestSubject("illegal-transitions", [11])
    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    service.startRun({
      sessionId: session.id,
      runId: "run_1",
      messageId: "message_1",
      createdAt: 2,
      messageCreatedAt: 3,
    })

    expect(() => service.completeRun("run_1")).toThrow(InvalidRunStatusTransitionError)

    try {
      service.completeRun("run_1")
      throw new Error("expected transition to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRunStatusTransitionError)
      expect(error).toMatchObject({
        runId: "run_1",
        fromStatus: "queued",
        toStatus: "completed",
      })
    }
  })

  test("rejects a second active run in the same session and creates a new run after completion", () => {
    const { repository, service } = createTestSubject("active-run-guard", [11, 22])
    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    const first = service.startRun({
      sessionId: session.id,
      runId: "run_1",
      messageId: "message_1",
      createdAt: 2,
      messageCreatedAt: 3,
    })

    expect(() =>
      service.startRun({
        sessionId: session.id,
        runId: "run_2",
        messageId: "message_2",
        createdAt: 4,
        messageCreatedAt: 5,
      }),
    ).toThrow(SessionBusyError)

    service.transitionRunToRunning(first.run.id)
    service.completeRun(first.run.id)

    const second = service.startRun({
      sessionId: session.id,
      runId: "run_2",
      messageId: "message_2",
      createdAt: 6,
      messageCreatedAt: 7,
    })

    expect(second.run.id).toBe("run_2")
    expect(second.run.id).not.toBe(first.run.id)
    expect(repository.messages.listSessionTranscript(session.id).map((message) => message.runId)).toEqual([
      "run_1",
      "run_2",
    ])
    expect(service.getSessionState(session.id)).toMatchObject({
      status: "busy",
      latestRun: { id: "run_2" },
      activeRun: { id: "run_2" },
    })
  })

  test("retry creates a new run and keeps the original initiating context addressable", () => {
    const { repository, service } = createTestSubject("retry", [11, 22, 33])
    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    const first = service.startRun({
      sessionId: session.id,
      runId: "run_1",
      messageId: "message_1",
      createdAt: 2,
      messageCreatedAt: 3,
    })

    service.transitionRunToRunning(first.run.id)
    service.failRun({
      runId: first.run.id,
      errorText: "provider exploded",
    })

    const retry = service.retryRun({
      sessionId: session.id,
      sourceRunId: first.run.id,
      runId: "run_2",
      messageId: "message_2",
      createdAt: 4,
      messageCreatedAt: 5,
    })

    expect(retry.run).toMatchObject({
      id: "run_2",
      sessionId: session.id,
      trigger: "retry",
      status: "queued",
    })
    expect(retry.message).toMatchObject({
      id: "message_2",
      runId: "run_2",
      role: "user",
    })
    expect(retry.sourceRun).toMatchObject({
      id: "run_1",
      sessionId: session.id,
      trigger: "prompt",
      status: "failed",
      errorText: "provider exploded",
    })
    expect(retry.sourceInitiatingMessage).toMatchObject({
      id: "message_1",
      runId: "run_1",
      role: "user",
      sequence: 0,
    })
    expect(repository.runs.get("run_1")).toMatchObject({
      id: "run_1",
      status: "failed",
      errorText: "provider exploded",
    })
    expect(service.getSessionState(session.id)).toMatchObject({
      status: "busy",
      latestRun: { id: "run_2", status: "queued" },
      activeRun: { id: "run_2", status: "queued" },
    })
  })

  test("cancelled runs remain terminal and the session can be reused", () => {
    const { repository, service } = createTestSubject("cancelled-terminal", [11, 22, 33])
    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })
    const first = service.startRun({
      sessionId: session.id,
      runId: "run_1",
      messageId: "message_1",
      createdAt: 2,
      messageCreatedAt: 3,
    })

    service.transitionRunToRunning(first.run.id)

    const cancelled = service.cancelRun(first.run.id)
    expect(cancelled).toMatchObject({
      id: "run_1",
      status: "cancelled",
      finishedAt: 22,
    })

    expect(() => service.resumeRun(first.run.id)).toThrow(InvalidRunStatusTransitionError)
    expect(() => service.completeRun(first.run.id)).toThrow(InvalidRunStatusTransitionError)

    const next = service.startRun({
      sessionId: session.id,
      runId: "run_2",
      messageId: "message_2",
      createdAt: 5,
      messageCreatedAt: 6,
    })

    expect(next.run).toMatchObject({
      id: "run_2",
      status: "queued",
    })
  })

  test("snapshots session active skills into each new run", () => {
    const { repository, service } = createTestSubject("run-skill-snapshot", [11, 22])
    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
      activeSkills: ["reviewer"],
    })

    const first = service.startRun({
      sessionId: session.id,
      runId: "run_1",
      messageId: "message_1",
      createdAt: 2,
      messageCreatedAt: 3,
    })

    expect(first.run.activeSkills).toEqual(["reviewer"])

    repository.sessions.update({
      sessionId: session.id,
      activeSkills: ["writer"],
    })

    expect(repository.runs.get(first.run.id).activeSkills).toEqual(["reviewer"])

    service.transitionRunToRunning(first.run.id)
    service.completeRun(first.run.id)

    const second = service.startRun({
      sessionId: session.id,
      runId: "run_2",
      messageId: "message_2",
      createdAt: 4,
      messageCreatedAt: 5,
    })

    expect(second.run.activeSkills).toEqual(["writer"])
  })

  test("only allows run active skill updates while the run is active", () => {
    const { repository, service } = createTestSubject("run-skill-update-state", [11, 22, 33])
    const session = repository.sessions.create({
      id: "session_1",
      directory: "/workspace",
      workspaceRoot: "/workspace",
      createdAt: 1,
    })

    const started = service.startRun({
      sessionId: session.id,
      runId: "run_1",
      messageId: "message_1",
      createdAt: 2,
      messageCreatedAt: 3,
    })

    const updatedWhileQueued = service.updateRunActiveSkills({
      runId: started.run.id,
      activeSkills: [" reviewer ", "writer", "reviewer"],
    })

    expect(updatedWhileQueued.activeSkills).toEqual(["reviewer", "writer"])

    service.transitionRunToRunning(started.run.id)
    service.completeRun(started.run.id)

    expect(() =>
      service.updateRunActiveSkills({
        runId: started.run.id,
        activeSkills: ["designer"],
      }),
    ).toThrow(RunActiveSkillsUpdateStateError)
    expect(repository.runs.get(started.run.id).activeSkills).toEqual(["reviewer", "writer"])
  })
})

function createTestSubject(prefix: string, nowValues: number[]) {
  const database = openStorageDatabase(createDatabasePath(prefix))
  trackDatabase(database)
  const repositoryNowValues = [...nowValues]
  const serviceNowValues = [...nowValues]

  const repository = createStorageRepository({
    database,
    now: () => {
      const value = repositoryNowValues.shift()
      if (value === undefined) {
        throw new Error("No timestamp left for repository.now()")
      }
      return value
    },
  })

  return {
    repository,
    service: createSessionRunService({
      repository,
      now: () => {
        const value = serviceNowValues.shift()
        if (value === undefined) {
          throw new Error("No timestamp left for service.now()")
        }
        return value
      },
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
