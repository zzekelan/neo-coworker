export type ProviderTextPart = {
  type: "text"
  text: string
}

export type ProviderToolCallPart = {
  type: "tool_call"
  callId: string
  toolName: string
  inputText: string
}

export type ProviderToolResultPart = {
  type: "tool_result"
  callId: string
  toolName: string
  output: string
  isError?: boolean
}

export type ProviderMessagePart =
  | ProviderTextPart
  | ProviderToolCallPart
  | ProviderToolResultPart

export type ProviderMessage = {
  role: "user" | "assistant" | "tool"
  parts: ProviderMessagePart[]
}

export type ProviderTurnRequest = {
  system: string
  messages: ProviderMessage[]
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
