export type ModelTextPart = {
  type: "text"
  text: string
}

export type ModelReasoningPart = {
  type: "reasoning"
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
  | ModelReasoningPart
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

export type ModelTimelinePart = ModelTranscriptPart & {
  entryId?: string
  producedByRunId?: string
  sequence?: number
}

export type ModelTimelineEntry = {
  role: "user" | "assistant" | "system" | "synthetic"
  producedByRunId?: string
  runId?: string
  runSequence?: number
  sequence?: number
  timelineSequence?: number
  parts: ModelTimelinePart[]
}

export type ModelTranscriptMessage = ModelTimelineEntry
