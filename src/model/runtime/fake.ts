import type { ProviderEvent, ProviderTurnRequest } from "./api"
import { createModelRuntimeApi } from "./api"

type FakeProviderInput = {
  events?: Iterable<ProviderEvent>
  onRequest?: (request: ProviderTurnRequest) => void | Promise<void>
}

export function createFakeProvider(input: FakeProviderInput = {}) {
  return createModelRuntimeApi({
    async *streamTurn(request) {
      await input.onRequest?.(request)

      for (const event of input.events ?? []) {
        yield event
      }
    },
  })
}
