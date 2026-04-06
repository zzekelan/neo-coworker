import { describe, expect, test } from "bun:test"
import { createBuiltinToolRuntime } from "../../../src/tool/infrastructure/runtime/create-builtin-runtime"

describe("datetime builtin runtime registration", () => {
  test("exposes datetime through the runtime registry", async () => {
    const runtime = createBuiltinToolRuntime()
    const tool = runtime.list().find((entry) => entry.name === "get_current_datetime")

    expect(tool).toBeDefined()
    expect(tool?.name).toBe("get_current_datetime")

    const result = await runtime.execute({
      toolName: "get_current_datetime",
      args: {},
      workspaceRoot: process.cwd(),
    })

    expect(result.output).toContain("Current datetime:")
  })
})
