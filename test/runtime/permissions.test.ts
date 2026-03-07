import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../src/runtime/permissions"

describe("permission coordinator", () => {
  test("waits for a user decision when policy is ask", async () => {
    const permissions = createPermissionCoordinator({
      read: "allow",
      write: "ask",
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
})
