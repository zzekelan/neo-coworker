import type { ProviderEvent, ProviderTurnRequest } from "../application/runtime-api"
import { createModelRuntimeApi } from "../application/runtime-api"

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
