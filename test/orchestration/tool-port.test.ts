import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../src/permission/runtime/coordinator"
import type { OrchestrationToolPort } from "../../src/orchestration/ports/tool"
import { createBuiltinToolRuntime } from "../../src/tool/runtime/runner"
import { createToolProvider } from "../../src/tool/wiring/provider"

describe("orchestration tool port", () => {
  test("lists the same builtin tools through the orchestration-facing port", () => {
    const permissions = createPermissionCoordinator({
      write: "allow",
      edit: "allow",
      shell: "allow",
    })
    const tools: OrchestrationToolPort = createToolProvider({
      runtime: createBuiltinToolRuntime({
        requestPermission(request) {
          return permissions.request(request)
        },
      }),
    })

    expect(tools.list().map((tool) => tool.name)).toEqual([
      "read",
      "search",
      "write",
      "edit",
      "shell",
    ])
  })
})
