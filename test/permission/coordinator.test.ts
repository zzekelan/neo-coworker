import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../src/permission/runtime/coordinator"

describe("permission coordinator", () => {
  test("publishes an ask request as soon as it is queued", async () => {
    const observed: Array<{
      requestId: string
      toolName: string
      reason: string
    }> = []
    const permissions = createPermissionCoordinator(
      {
        write: "ask",
      },
      {
        createRequestId: createMonotonicRequestIdGenerator(),
        onRequest(request) {
          observed.push(request)
        },
      },
    )

    const pending = permissions.request({
      toolName: "write",
      reason: "write notes.txt",
    })

    expect(observed).toEqual([
      {
        requestId: "permission_1",
        toolName: "write",
        reason: "write notes.txt",
      },
    ])

    permissions.resolve({
      requestId: "permission_1",
      decision: "allow",
    })

    await expect(pending).resolves.toEqual({
      requestId: "permission_1",
      decision: "allow",
    })
  })

  test("waits for a user decision when policy is ask", async () => {
    const permissions = createPermissionCoordinator({
      read: "allow",
      write: "ask",
    }, {
      createRequestId: createMonotonicRequestIdGenerator(),
    })

    const pending = permissions.request({
      toolName: "write",
      reason: "write notes.txt",
    })

    permissions.resolve({
      requestId: "permission_1",
      decision: "allow",
    })

    await expect(pending).resolves.toEqual({
      requestId: "permission_1",
      decision: "allow",
    })
  })

  test("keeps request ids monotonic after out-of-order resolution", async () => {
    const observed: string[] = []
    const permissions = createPermissionCoordinator(
      {
        write: "ask",
      },
      {
        createRequestId: createMonotonicRequestIdGenerator(),
        onRequest(request) {
          observed.push(request.requestId)
        },
      },
    )

    const first = permissions.request({
      toolName: "write",
      reason: "write notes.txt",
    })
    const second = permissions.request({
      toolName: "write",
      reason: "write agenda.txt",
    })

    permissions.resolve({
      requestId: "permission_2",
      decision: "deny",
    })

    const third = permissions.request({
      toolName: "write",
      reason: "write summary.txt",
    })

    expect(observed).toEqual(["permission_1", "permission_2", "permission_3"])

    permissions.resolve({
      requestId: "permission_1",
      decision: "allow",
    })
    permissions.resolve({
      requestId: "permission_3",
      decision: "allow",
    })

    await expect(first).resolves.toEqual({
      requestId: "permission_1",
      decision: "allow",
    })
    await expect(second).resolves.toEqual({
      requestId: "permission_2",
      decision: "deny",
    })
    await expect(third).resolves.toEqual({
      requestId: "permission_3",
      decision: "allow",
    })
  })

  test("throws when resolving an unknown request id", () => {
    const permissions = createPermissionCoordinator({
      write: "ask",
    })

    expect(() =>
      permissions.resolve({
        requestId: "permission_404",
        decision: "deny",
      }),
    ).toThrow("Unknown permission request")
  })

  test("cleans up a pending request when publishing it throws", async () => {
    const unhandledRejections: string[] = []
    const handleUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason instanceof Error ? reason.message : String(reason))
    }
    const permissions = createPermissionCoordinator(
      {
        write: "ask",
      },
      {
        createRequestId: createMonotonicRequestIdGenerator(),
        onRequest() {
          throw new Error("permission storage unavailable")
        },
      },
    )

    process.on("unhandledRejection", handleUnhandledRejection)

    try {
      await expect(
        permissions.request({
          toolName: "write",
          reason: "write notes.txt",
        }),
      ).rejects.toThrow("permission storage unavailable")

      permissions.cancelAll()
      await Bun.sleep(0)

      expect(() =>
        permissions.resolve({
          requestId: "permission_1",
          decision: "allow",
        }),
      ).toThrow("Unknown permission request")
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off("unhandledRejection", handleUnhandledRejection)
    }
  })
})

function createMonotonicRequestIdGenerator() {
  let nextRequestId = 1
  return () => {
    const requestId = `permission_${nextRequestId}`
    nextRequestId += 1
    return requestId
  }
}
