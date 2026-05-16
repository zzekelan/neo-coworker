import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assertRunStatusTransition,
  createSessionRunService,
  resolvePermissionPendingRunStatus,
} from "../../src/session"
import {
  createSessionRepository,
  openSessionDatabase,
  type SessionRepository,
} from "../../src/session"
import {
  createPermissionRepository,
} from "../../src/permission"
import {
  PermissionRequestNotPendingError,
  PermissionRequestRunStateError,
  createPermissionQueryService,
  createPermissionRequestService,
  createPermissionRespondService,
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

  test("requestPermission allows two pending requests in the same run", () => {
    const harness = createHarness("request-two-pending", [20, 30, 40])

    harness.request.requestPermission({
      runId: harness.run.id,
      permissionRequest: {
        id: "permission_1",
        toolName: "shell",
        reason: "inspect worktree",
        createdAt: 11,
      },
    })

    const result = harness.request.requestPermission({
      runId: harness.run.id,
      permissionRequest: {
        id: "permission_2",
        toolName: "write",
        reason: "write notes.txt",
        createdAt: 12,
      },
    })

    expect(result.run).toMatchObject({
      id: harness.run.id,
      status: "waiting_permission",
    })
    expect(harness.permissionRepository.requests.listByRun(harness.run.id)).toMatchObject([
      {
        id: "permission_1",
        status: "pending",
        toolName: "shell",
      },
      {
        id: "permission_2",
        status: "pending",
        toolName: "write",
      },
    ])
  })

  test("requestPermission persists patch approval details without active preview payloads", () => {
    const harness = createHarness("request-patch-details", [20, 30, 40])
    const approvalDetails = {
      kind: "patch" as const,
      fileCount: 1,
      additions: 1,
      deletions: 1,
      files: [
        {
          path: "notes.txt",
          operation: "update",
          additions: 1,
          deletions: 1,
        },
      ],
    }

    harness.request.requestPermission({
      runId: harness.run.id,
      permissionRequest: {
        id: "permission_patch",
        toolName: "apply_patch",
        reason: "apply_patch notes.txt",
        createdAt: 11,
        approvalDetails,
        preview: {
          kind: "patch",
          text: "--- a/notes.txt\n+++ b/notes.txt\n@@\n-old\n+new",
          truncated: false,
          limitBytes: 64 * 1024,
          originalBytes: 43,
          displayedBytes: 43,
        },
      },
    })

    const stored = harness.permissionRepository.requests.get("permission_patch")

    expect(stored.approvalDetails).toEqual(approvalDetails)
    expect("preview" in stored).toBe(false)
    expect(JSON.stringify(stored)).not.toContain("*** Begin Patch")
    expect(JSON.stringify(stored)).not.toContain("--- a/notes.txt")
  })

  test("requestPermission preserves creation order for requests from the same runtime tick", () => {
    const harness = createHarness("request-same-tick-order", [20, 30, 40])

    harness.request.requestPermission({
      runId: harness.run.id,
      permissionRequest: {
        id: "permission_b",
        toolName: "webfetch",
        reason: "webfetch data:text/plain,second",
        createdAt: 11,
      },
    })
    harness.request.requestPermission({
      runId: harness.run.id,
      permissionRequest: {
        id: "permission_a",
        toolName: "webfetch",
        reason: "webfetch data:text/plain,first",
        createdAt: 11,
      },
    })

    expect(
      harness.permissionRepository.requests
        .listByRun(harness.run.id)
        .map((request) => request.reason),
    ).toEqual([
      "webfetch data:text/plain,second",
      "webfetch data:text/plain,first",
    ])
  })

  test("requestPermission keeps the run blocked if a new request fails while an older pending request exists", () => {
    const harness = createHarness("request-rollback", [20, 30, 40])
    const requestWithFailingCreate = createPermissionRequestService({
      repository: {
        ...harness.permissionRepository,
        requests: {
          ...harness.permissionRepository.requests,
          create(request) {
            if (request.id === "permission_2") {
              throw new Error("simulated request persistence failure")
            }

            return harness.permissionRepository.requests.create(request)
          },
        },
      },
      session: createPermissionSessionPort({
        repository: harness.sessionRepository,
        permissionRepository: harness.permissionRepository,
        sessionRuns: harness.sessionRuns,
      }),
    })

    harness.request.requestPermission({
      runId: harness.run.id,
      permissionRequest: {
        id: "permission_1",
        toolName: "shell",
        reason: "inspect worktree",
        createdAt: 11,
      },
    })

    expect(() =>
      requestWithFailingCreate.requestPermission({
        runId: harness.run.id,
        permissionRequest: {
          id: "permission_2",
          toolName: "write",
          reason: "write notes.txt",
          createdAt: 12,
        },
      }),
    ).toThrow("simulated request persistence failure")

    expect(harness.sessionRepository.runs.get(harness.run.id)).toMatchObject({
      id: harness.run.id,
      status: "waiting_permission",
    })
    expect(harness.permissionRepository.requests.listByRun(harness.run.id)).toMatchObject([
      {
        id: "permission_1",
        status: "pending",
      },
    ])
  })

  test("respondPermission keeps the run waiting until the last pending request resolves", () => {
    const harness = createHarness("respond-multi-pending", [20, 30, 40])

    harness.sessionRepository.runs.updateStatus({
      runId: harness.run.id,
      status: "waiting_permission",
    })
    harness.permissionRepository.requests.create({
      id: "permission_1",
      sessionId: harness.session.id,
      runId: harness.run.id,
      toolName: "write",
      reason: "write notes.txt",
      createdAt: 11,
    })
    harness.permissionRepository.requests.create({
      id: "permission_2",
      sessionId: harness.session.id,
      runId: harness.run.id,
      toolName: "shell",
      reason: "inspect worktree",
      createdAt: 12,
    })

    const firstReply = harness.respond.respondPermission({
      requestId: "permission_2",
      decision: "allow",
      resolvedAt: 99,
    })

    expect(firstReply.run).toMatchObject({
      id: harness.run.id,
      status: "waiting_permission",
      startedAt: 3,
    })
    expect(firstReply.permissionRequest).toMatchObject({
      id: "permission_2",
      status: "approved",
      resolvedAt: 99,
    })
    expect(harness.permissionRepository.requests.listByRun(harness.run.id)).toMatchObject([
      {
        id: "permission_1",
        status: "pending",
      },
      {
        id: "permission_2",
        status: "approved",
        resolvedAt: 99,
      },
    ])
    expect(harness.sessionRepository.runs.get(harness.run.id)).toMatchObject({
      id: harness.run.id,
      status: "waiting_permission",
    })

    const lastReply = harness.respond.respondPermission({
      requestId: "permission_1",
      decision: "allow",
      resolvedAt: 100,
    })

    expect(lastReply.run).toMatchObject({
      id: harness.run.id,
      status: "running",
      startedAt: 3,
    })
    expect(lastReply.permissionRequest).toMatchObject({
      id: "permission_1",
      status: "approved",
      resolvedAt: 100,
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

function createHarness(
  prefix: string,
  nowValues: number[],
) {
  const database = openSessionDatabase(createDatabasePath(prefix))
  trackDatabase(database)

  const nextSessionNow = createNow(nowValues)
  const sessionRepository = createSessionRepository({
    database,
    now: nextSessionNow,
  })
  const permissionRepository = createPermissionRepository({ database })
  const sessionRuns = createSessionRunService({
    repository: sessionRepository,
    now: createNow(nowValues),
  })

  const session = sessionRepository.sessions.create({
    id: "session_1",
    directory: "/workspace",
    workspaceRoot: "/workspace",
    createdAt: 1,
  })
  const run = sessionRepository.runs.create({
    id: "run_1",
    sessionId: session.id,
    trigger: "cli",
    status: "running",
    createdAt: 2,
    startedAt: 3,
  })

  const sessionPort = createPermissionSessionPort({
    repository: sessionRepository,
    permissionRepository,
    sessionRuns,
  })

  return {
    sessionRepository,
    permissionRepository,
    query: createPermissionQueryService({ repository: permissionRepository, session: sessionPort }),
    request: createPermissionRequestService({
      repository: permissionRepository,
      session: sessionPort,
    }),
    respond: createPermissionRespondService({
      repository: permissionRepository,
      session: sessionPort,
    }),
    sessionRuns,
    session,
    run,
  }
}

function createPermissionSessionPort(input: {
  repository: SessionRepository
  permissionRepository: ReturnType<typeof createPermissionRepository>
  sessionRuns: Pick<ReturnType<typeof createSessionRunService>, "transitionRunToRunning">
}) {
  return {
    getRun(runId: string) {
      return input.repository.runs.get(runId)
    },
    syncRunStatusWithPendingRequests(runId: string) {
      const run = input.repository.runs.get(runId)
      const nextStatus = resolvePermissionPendingRunStatus(
        input.permissionRepository.requests.listByRun(runId).filter((request) => request.status === "pending").length,
      )
      if (run.status === nextStatus) {
        return run
      }

      if (nextStatus === "waiting_permission") {
        assertRunStatusTransition(run, nextStatus)
        return input.repository.runs.updateStatus({
          runId,
          status: nextStatus,
        })
      }

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
