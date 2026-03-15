import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assertRunStatusTransition,
  createConversationRunService,
} from "../../src/conversation/service"
import {
  createConversationRepository,
  openConversationDatabase,
  type ConversationRepository,
} from "../../src/conversation/repo"
import {
  createPermissionRepository,
  type PermissionRepository,
} from "../../src/permission/repo"
import {
  PermissionRequestNotPendingError,
  PermissionRequestRunStateError,
  createPermissionQueryService,
  createPermissionRequestService,
  createPermissionRespondService,
} from "../../src/permission/service"

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

describe("permission service", () => {
  test("requestPermission persists a pending request and blocks the run", () => {
    const harness = createHarness("request-persist", [20, 30, 40])

    const result = harness.request.requestPermission({
      runId: harness.run.id,
      permissionRequest: {
        id: "permission_1",
        toolName: "shell",
        reason: "inspect worktree",
        createdAt: 11,
      },
    })

    expect(result.run).toMatchObject({
      id: harness.run.id,
      status: "waiting_permission",
    })
    expect(result.permissionRequest).toMatchObject({
      id: "permission_1",
      sessionId: harness.session.id,
      runId: harness.run.id,
      toolName: "shell",
      status: "pending",
      resolvedAt: null,
    })
    expect(harness.permissionRepository.requests.listByRun(harness.run.id)).toHaveLength(1)
  })

  test("requestPermission restores the running state if request persistence fails", () => {
    const harness = createHarness("request-rollback", [20, 30, 40])

    harness.permissionRepository.requests.create({
      id: "permission_duplicate",
      sessionId: harness.session.id,
      runId: harness.run.id,
      toolName: "shell",
      reason: "existing request",
      createdAt: 10,
    })

    expect(() =>
      harness.request.requestPermission({
        runId: harness.run.id,
        permissionRequest: {
          id: "permission_duplicate",
          toolName: "shell",
          reason: "inspect worktree",
          createdAt: 11,
        },
      }),
    ).toThrow(/UNIQUE|constraint/i)

    expect(harness.conversationRepository.runs.get(harness.run.id)).toMatchObject({
      id: harness.run.id,
      status: "running",
    })
    expect(harness.permissionRepository.requests.listByRun(harness.run.id)).toHaveLength(1)
  })

  test("respondPermission resolves the request and resumes the same run", () => {
    const harness = createHarness("respond-resume", [20, 30, 40])

    harness.request.requestPermission({
      runId: harness.run.id,
      permissionRequest: {
        id: "permission_1",
        toolName: "write",
        reason: "write notes.txt",
        createdAt: 11,
      },
    })

    const result = harness.respond.respondPermission({
      requestId: "permission_1",
      decision: "allow",
      resolvedAt: 99,
    })

    expect(result.run).toMatchObject({
      id: harness.run.id,
      status: "running",
      startedAt: 3,
    })
    expect(result.permissionRequest).toMatchObject({
      id: "permission_1",
      status: "approved",
      resolvedAt: 99,
    })
  })

  test("duplicate and stale replies are rejected explicitly", () => {
    const duplicateHarness = createHarness("duplicate-reply", [20, 30, 40])
    duplicateHarness.request.requestPermission({
      runId: duplicateHarness.run.id,
      permissionRequest: {
        id: "permission_1",
        toolName: "shell",
        reason: "inspect worktree",
        createdAt: 11,
      },
    })
    duplicateHarness.respond.respondPermission({
      requestId: "permission_1",
      decision: "deny",
      resolvedAt: 88,
    })

    expect(() =>
      duplicateHarness.respond.respondPermission({
        requestId: "permission_1",
        decision: "allow",
        resolvedAt: 99,
      }),
    ).toThrow(PermissionRequestNotPendingError)

    const staleHarness = createHarness("stale-reply", [20, 30, 40, 50])
    staleHarness.request.requestPermission({
      runId: staleHarness.run.id,
      permissionRequest: {
        id: "permission_2",
        toolName: "write",
        reason: "write notes.txt",
        createdAt: 11,
      },
    })
    staleHarness.sessionRuns.cancelRun(staleHarness.run.id)

    expect(() =>
      staleHarness.respond.respondPermission({
        requestId: "permission_2",
        decision: "allow",
        resolvedAt: 100,
      }),
    ).toThrow(PermissionRequestRunStateError)
  })

  test("cancelPendingRequestsByRun only resolves pending requests", () => {
    const harness = createHarness("cancel-pending", [20, 30, 40])

    harness.permissionRepository.requests.create({
      id: "permission_pending",
      sessionId: harness.session.id,
      runId: harness.run.id,
      toolName: "shell",
      reason: "inspect worktree",
      createdAt: 11,
    })
    harness.permissionRepository.requests.create({
      id: "permission_approved",
      sessionId: harness.session.id,
      runId: harness.run.id,
      toolName: "write",
      reason: "write notes.txt",
      status: "approved",
      createdAt: 12,
      resolvedAt: 13,
    })

    const cancelled = harness.query.cancelPendingRequestsByRun(harness.run.id, 99)

    expect(cancelled).toMatchObject([
      {
        id: "permission_pending",
        status: "cancelled",
        resolvedAt: 99,
      },
    ])
    expect(harness.permissionRepository.requests.get("permission_approved")).toMatchObject({
      id: "permission_approved",
      status: "approved",
      resolvedAt: 13,
    })
  })
})

function createHarness(prefix: string, nowValues: number[]) {
  const database = openConversationDatabase(createDatabasePath(prefix))
  trackDatabase(database)

  const nextConversationNow = createNow(nowValues)
  const conversationRepository = createConversationRepository({
    database,
    now: nextConversationNow,
  })
  const permissionRepository = createPermissionRepository({ database })
  const sessionRuns = createConversationRunService({
    repository: conversationRepository,
    now: createNow(nowValues),
  })

  const session = conversationRepository.sessions.create({
    id: "session_1",
    directory: "/workspace",
    workspaceRoot: "/workspace",
    createdAt: 1,
  })
  const run = conversationRepository.runs.create({
    id: "run_1",
    sessionId: session.id,
    trigger: "cli",
    status: "running",
    createdAt: 2,
    startedAt: 3,
  })

  const conversation = createPermissionConversationPort({
    repository: conversationRepository,
    sessionRuns,
  })

  return {
    conversationRepository,
    permissionRepository,
    query: createPermissionQueryService({ repository: permissionRepository }),
    request: createPermissionRequestService({
      repository: permissionRepository,
      conversation,
    }),
    respond: createPermissionRespondService({
      repository: permissionRepository,
      conversation,
    }),
    sessionRuns,
    session,
    run,
  }
}

function createPermissionConversationPort(input: {
  repository: ConversationRepository
  sessionRuns: Pick<ReturnType<typeof createConversationRunService>, "transitionRunToRunning">
}) {
  return {
    getRun(runId: string) {
      return input.repository.runs.get(runId)
    },
    transitionRunToWaitingPermission(runId: string) {
      const run = input.repository.runs.get(runId)
      assertRunStatusTransition(run, "waiting_permission")
      return input.repository.runs.updateStatus({
        runId,
        status: "waiting_permission",
      })
    },
    transitionRunToRunning(runId: string) {
      return input.sessionRuns.transitionRunToRunning(runId)
    },
  }
}

function createNow(values: number[]) {
  return () => {
    const value = values.shift()
    if (value === undefined) {
      throw new Error("No timestamp left for now()")
    }
    return value
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
