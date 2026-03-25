import { describe, expect, test } from "bun:test"
import {
  runEvalTask,
  type EvalProviderFactory,
} from "../../evals"
import {
  createModelProvider,
  createModelRuntimeApi,
  type ModelObserverPort,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model"

describe("eval runner", () => {
  test("runs the real runtime path and grades exported trace artifacts", async () => {
    const result = await runEvalTask({
      task: {
        id: "read-summary",
        prompt: "Read README.md and summarize it",
        workspaceRoot: "test/fixtures/workspaces/read-search",
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
    expect(result.artifact.trace?.events.map((event) => event.eventType)).toContain(
      "model.turn.requested",
    )
    expect(result.traceGrade).toEqual({
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
