import { describe, expect, test } from "bun:test"
import { createDatetimeTool } from "../../../src/tool/infrastructure/builtins/datetime"

describe("datetime tool", () => {
  test("returns current datetime metadata and formatted output", async () => {
    const tool = createDatetimeTool()

    const result = await tool.execute({
      toolName: "get_current_datetime",
      args: {},
      workspaceRoot: process.cwd(),
    })

    expect(result.output).toMatch(/^Current datetime: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\nTimezone: .+\nUTC offset: [+-]\d{2}:\d{2}\nEpoch ms: \d+$/)
    expect(result.metadata).toEqual({
      iso: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/),
      timezone: expect.any(String),
      utcOffset: expect.stringMatching(/^[+-]\d{2}:\d{2}$/),
      epoch_ms: expect.any(Number),
    })
  })
})
