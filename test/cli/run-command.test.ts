import { describe, expect, test } from "bun:test"
import type { PermissionResponse } from "../../src/runtime/permissions"
import { runCli } from "../../src/cli/run-command"

describe("run command", () => {
  test("renders streamed events and answers permission prompts", async () => {
    const output: string[] = []
    const permissionResponses: PermissionResponse[] = []
    const runCalls: Array<{ prompt: string; cwd: string; workspaceRoot: string }> = []

    await runCli({
      argv: ["run", "inspect the workspace"],
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      io: {
        write(text: string) {
          output.push(text)
        },
        async prompt() {
          return "y"
        },
        onSigint() {},
      },
      runtime: {
        async run(input) {
          runCalls.push(input)

          return {
            events: (async function* () {
              yield { type: "run.started", runId: "run_1" } as const
              yield { type: "message.started", role: "assistant" } as const
              yield { type: "message.delta", text: "Inspecting\n" } as const
              yield {
                type: "permission.requested",
                requestId: "permission_1",
                toolName: "write",
                reason: "write notes.txt",
              } as const
              yield {
                type: "tool.call.completed",
                callId: "call_1",
                name: "write",
                output: "Wrote notes.txt",
              } as const
              yield { type: "run.completed", runId: "run_1" } as const
            })(),
            cancel() {},
            respondPermission(input: PermissionResponse) {
              permissionResponses.push(input)
            },
          }
        },
      },
    })

    expect(runCalls).toEqual([
      {
        prompt: "inspect the workspace",
        cwd: "/workspace",
        workspaceRoot: "/workspace",
      },
    ])
    expect(permissionResponses).toEqual([
      {
        requestId: "permission_1",
        decision: "allow",
      },
    ])
    expect(output.join("")).toContain("run.started")
    expect(output.join("")).toContain("write notes.txt")
    expect(output.join("")).toContain("run.completed")
  })

  test("cancels the run when SIGINT is received", async () => {
    const output: string[] = []
    let sigintHandler: (() => void) | undefined
    let cancelCalls = 0
    let releaseEvents!: () => void
    const cancelSignal = new Promise<void>((resolve) => {
      releaseEvents = resolve
    })

    const runPromise = runCli({
      argv: ["run", "inspect the workspace"],
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      io: {
        write(text: string) {
          output.push(text)
        },
        async prompt() {
          return "y"
        },
        onSigint(listener: () => void) {
          sigintHandler = listener
        },
      },
      runtime: {
        async run() {
          return {
            events: (async function* () {
              yield { type: "run.started", runId: "run_1" } as const
              await cancelSignal
              yield { type: "run.cancelled", runId: "run_1" } as const
            })(),
            cancel() {
              cancelCalls += 1
              releaseEvents()
            },
            respondPermission() {},
          }
        },
      },
    })

    await Promise.resolve()
    expect(sigintHandler).toBeDefined()
    sigintHandler?.()
    await runPromise

    expect(cancelCalls).toBe(1)
    expect(output.join("")).toContain("run.cancelled")
  })
})
