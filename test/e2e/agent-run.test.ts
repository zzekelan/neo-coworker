import { describe, expect, test } from "bun:test"
import { runCli } from "../../src/cli/run-command"
import { createFakeProvider } from "../../src/providers/fake"

describe("agent run e2e", () => {
  test("completes a read-only request against a fixture workspace", async () => {
    const output: string[] = []

    await runCli({
      argv: ["run", "Read README.md and summarize it"],
      cwd: "test/fixtures/workspaces/e2e",
      workspaceRoot: "test/fixtures/workspaces/e2e",
      provider: createFakeProvider({
        events: [
          { type: "text.delta", text: "Opening README.md\n" },
          {
            type: "tool.call",
            callId: "call_1",
            name: "read",
            inputText: '{"path":"README.md"}',
          },
          { type: "text.delta", text: "Summary: concise fixture summary.\n" },
        ],
      }),
      io: {
        write(text: string) {
          output.push(text)
        },
        async prompt() {
          throw new Error("read-only e2e should not request permission")
        },
        onSigint() {},
      },
    })

    const rendered = output.join("")

    expect(rendered).toContain("run.started")
    expect(rendered).toContain("tool.call.completed read:")
    expect(rendered).toContain("# e2e fixture")
    expect(rendered).toContain("Summary: concise fixture summary.")
    expect(rendered).toContain("run.completed")
  })
})
