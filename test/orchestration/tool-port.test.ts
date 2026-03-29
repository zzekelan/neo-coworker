import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../src/permission"
import type { OrchestrationToolPort } from "../../src/orchestration"
import { createBuiltinToolRuntime, createToolProvider } from "../../src/tool"

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
      "glob",
      "grep",
      "webfetch",
      "websearch",
      "codesearch",
      "write",
      "edit",
      "shell",
    ])
  })
})
