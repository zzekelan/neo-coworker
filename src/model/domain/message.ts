export type ModelTextPart = {
  type: "text"
  text: string
}

export type ModelToolCallPart = {
  type: "tool_call"
  callId: string
  toolName: string
  inputText: string
}

export type ModelToolResultPart = {
  type: "tool_result"
  callId: string
  toolName: string
  output: string
  isError?: boolean
  metadata?: Record<string, unknown>
}

export type ModelMessagePart =
  | ModelTextPart
  | ModelToolCallPart
  | ModelToolResultPart

export type ModelMessage = {
  role: "user" | "assistant" | "tool"
  parts: ModelMessagePart[]
}

export type ModelTranscriptPart = {
  kind: string
  text: string | null
  data?: unknown
}

export type ModelTranscriptMessage = {
  role: "user" | "assistant" | "system" | "synthetic"
  parts: ModelTranscriptPart[]
}
