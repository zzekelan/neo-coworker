import {
  createModelProvider,
  createModelRuntimeApi,
  type ModelObserverPort,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model"
import type { EvalProviderFactory } from "../runner"

type ScriptedTurn = (request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>

export function createScriptedEvalProviderFactory(scenario: string): EvalProviderFactory {
  return (input: { modelObserver?: ModelObserverPort }) => {
    let turnIndex = 0
    const turns = buildScenarioTurns(scenario)

    return createModelProvider({
      observer: input.modelObserver,
      runtime: createModelRuntimeApi({
        async *streamTurn(request: ProviderTurnRequest) {
          const turn = turns[turnIndex]
          turnIndex += 1

          if (!turn) {
            throw new Error(`Unexpected provider turn ${turnIndex} for scenario ${scenario}`)
          }

          for await (const event of turn(request)) {
            yield event
          }
        },
      }),
    })
  }
}

function buildScenarioTurns(scenario: string): ScriptedTurn[] {
  switch (scenario) {
    case "read-only":
      return [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_readme",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Read-only fixture summary ready." }
        },
      ]
    case "permission-allow-write":
      return [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_allow",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello from eval allow"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Write completed after permission approval." }
        },
      ]
    case "permission-deny-write":
      return [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_deny",
            name: "write",
            inputText: '{"path":"notes.txt","content":"deny should not write"}',
          }
        },
      ]
    case "retry-recovery":
      return [
        async function* () {
          throw new Error("transient eval provider failure")
        },
        async function* () {
          yield { type: "text.delta", text: "Recovered after retry." }
        },
      ]
    case "cancel-after-output":
      return [
        async function* (request) {
          yield { type: "text.delta", text: "Partial output before cancellation." }
          await waitForAbort(request.signal)
        },
      ]
    default:
      throw new Error(`Unknown eval scenario: ${scenario}`)
  }
}

async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) {
    return
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), {
      once: true,
    })
  })
}
