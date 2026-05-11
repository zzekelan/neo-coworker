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

export type ModelTimelinePart = {
  kind: string
  text: string | null
  data?: unknown
  entryId?: string
  producedByRunId?: string
  sequence?: number
}

export type ModelTimelineEntry = {
  role: "user" | "assistant" | "system" | "compaction"
  producedByRunId?: string
  runId?: string
  runSequence?: number
  sequence?: number
  timelineSequence?: number
  parts: ModelTimelinePart[]
}

export type ModelTimelineMessage = ModelTimelineEntry
