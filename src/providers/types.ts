export type ProviderTurnRequest = {
  system: string
  messages: unknown[]
  tools: unknown[]
  signal: AbortSignal
}

export type ProviderEvent =
  | {
      type: "text.delta"
      text: string
    }
  | {
      type: "tool.call"
      callId: string
      name: string
      inputText: string
    }

export interface Provider {
  streamTurn(request: ProviderTurnRequest): AsyncIterable<ProviderEvent>
}
