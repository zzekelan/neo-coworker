export type ProviderEvent = import("../../domain").ModelEvent
export type ProviderTurnRequest = import("../../domain").ModelTurnRequest

export type Provider = {
  streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderEvent>
}
