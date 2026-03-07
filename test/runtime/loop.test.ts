import { describe, expect, test } from "bun:test"
import { createFakeProvider } from "../../src/providers/fake"
import { createRuntime } from "../../src/runtime/runtime"

describe("agent loop", () => {
  test("streams assistant text, executes tools, and completes the run", async () => {
    const runtime = createRuntime({
      provider: createFakeProvider({
        events: [
          { type: "text.delta", text: "Looking at the file." },
          {
            type: "tool.call",
            callId: "call_1",
            name: "read",
            inputText: '{"path":"README.md"}',
          },
          { type: "text.delta", text: "Done." },
        ],
      }),
    })

    const handle = await runtime.run({
      prompt: "Inspect README.md",
      cwd: "test/fixtures/workspaces/read-search",
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    const eventTypes = []
    for await (const event of handle.events) {
      eventTypes.push(event.type)
    }

    expect(eventTypes).toContain("run.started")
    expect(eventTypes).toContain("tool.call.completed")
    expect(eventTypes.at(-1)).toBe("run.completed")
  })
})
