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
    case "datetime":
      return [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_datetime",
            name: "get_current_datetime",
            inputText: "{}",
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Datetime tool returned Current datetime, Timezone, UTC offset, and Epoch ms.",
          }
        },
      ]
    case "ncoworker-path-safety":
      return [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_ncoworker_research",
            name: "read",
            inputText: '{"path":".ncoworker/research/browser-security/brief.md"}',
          }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_ncoworker",
            name: "read",
            inputText: '{"path":".ncoworker/secret.txt"}',
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Research path allowed; runtime path protected: Path is reserved for agent runtime data.",
          }
        },
      ]
    case "sub-agent-explore":
      return [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_agent_explore",
            name: "agent",
            inputText:
              '{"agent":"explore","prompt":"Read README.md and report the heading."}',
          }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_subagent_read",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Sub-agent explored README heading.",
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Delegation result: Sub-agent explored README heading.",
          }
        },
      ]
    case "sub-agent-parallel-safety":
      return [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_agent_one",
            name: "agent",
            inputText: '{"agent":"explore","prompt":"Parallel branch one."}',
          }
          yield {
            type: "tool.call",
            callId: "call_agent_two",
            name: "agent",
            inputText: '{"agent":"explore","prompt":"Parallel branch two."}',
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Parallel sub-agent branch one complete.",
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Parallel sub-agent branch two complete.",
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Parallel delegation complete.",
          }
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
        async function* (_request) {
          if (_request.signal.aborted) {
            yield { type: "text.delta", text: "unreachable" } as ProviderEvent
          }
          throw createRetryableProviderError("transient eval provider failure")
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

function createRetryableProviderError(message: string) {
  const error = new Error(message) as Error & {
    classified?: {
      reason: string
      original: Error
      retryable: boolean
      shouldCompress: boolean
      shouldRotateCredential: boolean
      shouldFallback: boolean
    }
  }
  error.classified = {
    reason: "timeout",
    original: error,
    retryable: true,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
  }
  return error
}
