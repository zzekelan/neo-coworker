import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  runEvalTask,
  type EvalProviderFactory,
} from "../../evals"
import {
  createOrchestrationActiveRunRegistry,
  createSessionRepository,
  openSessionDatabase,
} from "../../src/bootstrap"
import {
  createModelProvider,
  createModelRuntimeApi,
  type ModelObserverPort,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model"

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("eval runner", () => {
  test("runs the real runtime path and grades exported trace artifacts", async () => {
    const result = await runEvalTask({
      task: {
        id: "read-summary",
        prompt: "Read README.md and summarize it",
        workspaceRoot: "test/fixtures/workspaces/read-search",
        outcomeExpectation: {
          runStatus: "completed",
          watchedFiles: [],
        },
        protocolExpectation: {
          requiredRuntimeEventTypes: [
            "run.started",
            "tool.call.completed",
            "run.completed",
          ],
          forbiddenRuntimeEventTypes: ["permission.requested", "run.failed", "run.cancelled"],
        },
        toolPolicyExpectation: {
          requiredToolNames: ["read"],
          forbiddenToolNames: ["write", "edit", "shell"],
        },
        traceExpectation: {
          requiredEventTypes: [
            "run.started",
            "tool.call.completed",
            "run.completed",
          ],
        },
      },
      createProvider: createProviderFactory([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Fixture summary ready." }
        },
      ]),
    })

    expect(result.artifact.runStatus).toBe("completed")
    expect(result.artifact.outcome).toMatchObject({
      runStatus: "completed",
      errorText: null,
      watchedFiles: [],
    })
    expect(result.artifact.metrics).toMatchObject({
      modelTurnCount: 2,
      toolCallCount: 1,
      permissionWaitCount: 0,
      retryCount: 0,
      terminalEventType: "run.completed",
    })
    expect(result.artifact.trace?.events.map((event) => event.eventType)).toContain(
      "model.turn.requested",
    )
    expect(result.pass).toBe(true)
    expect(result.grades.trace).toEqual({
      pass: true,
      requiredEventTypes: [
        "run.started",
        "tool.call.completed",
        "run.completed",
      ],
      observedEventTypes: expect.arrayContaining([
        "run.started",
        "tool.call.completed",
        "run.completed",
      ]),
      missingEventTypes: [],
    })
    expect(result.grades.outcome.pass).toBe(true)
    expect(result.grades.protocol.pass).toBe(true)
    expect(result.grades.toolPolicy.pass).toBe(true)
  })

  test("cancels the active run when permission requests are not auto-replied", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eval-runner-permission-"))
    tempDirectories.push(workspaceRoot)
    await mkdir(join(workspaceRoot, "src"), { recursive: true })

    const activeRuns = createOrchestrationActiveRunRegistry()
    let started:
      | {
          storageIdentity: string
          sessionId: string
          runId: string
        }
      | undefined

    await expect(
      runEvalTask({
        task: {
          id: "permission-missing",
          prompt: "Run pwd",
          workspaceRoot,
          copyWorkspace: false,
        },
        createProvider: createProviderFactory([
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_shell",
              name: "shell",
              inputText: '{"command":"pwd"}',
            }
          },
        ]),
        activeRuns,
        onRunStarted(input) {
          started = input
        },
      }),
    ).rejects.toThrow("without autoReplyPermission")

    expect(started).toBeDefined()
    expect(activeRuns.has(started!)).toBe(false)

    const database = openSessionDatabase(started!.storageIdentity)

    try {
      const repository = createSessionRepository({
        database,
        now: () => 100,
      })

      expect(repository.runs.get(started!.runId).status).toBe("cancelled")
    } finally {
      database.close(false)
    }
  })
})

function createProviderFactory(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
): EvalProviderFactory {
  return (input: { modelObserver?: ModelObserverPort }) => {
    let index = 0

    return createModelProvider({
      observer: input.modelObserver,
      runtime: createModelRuntimeApi({
        async *streamTurn(request: ProviderTurnRequest) {
          const turn = turns[index]
          index += 1

          if (!turn) {
            throw new Error(`Unexpected provider turn ${index}`)
          }

          for await (const event of turn(request)) {
            yield event
          }
        },
      }),
    })
  }
}
