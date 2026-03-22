import type {
  Provider,
  ProviderEvent,
  ProviderTurnRequest,
} from "../../application/ports/provider"

type FakeProviderInput = {
  events?: Iterable<ProviderEvent>
  onRequest?: (request: ProviderTurnRequest) => void | Promise<void>
}

export function createFakeProvider(input: FakeProviderInput = {}): Provider {
  return {
    async *streamTurn(request) {
      await input.onRequest?.(request)

      for (const event of input.events ?? []) {
        yield event
      }
    },
  }
}
