import type { Provider, ProviderEvent, ProviderTurnRequest } from "./types"

type FakeProviderInput = {
  events?: Iterable<ProviderEvent>
  onRequest?: (request: ProviderTurnRequest) => void | Promise<void>
}

export function createFakeProvider(input: FakeProviderInput = {}): Provider {
  return {
    async *streamTurn(
      request: ProviderTurnRequest,
    ): AsyncGenerator<ProviderEvent, void, void> {
      await input.onRequest?.(request)

      for (const event of input.events ?? []) {
        yield event
      }
    },
  }
}
