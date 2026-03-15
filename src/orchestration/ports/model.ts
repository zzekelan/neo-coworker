import type { OrchestrationTool } from "./tool"

export type OrchestrationTranscriptPart = {
  kind: string
  text: string | null
  data?: unknown
}

export type OrchestrationTranscriptMessage = {
  role: "user" | "assistant" | "system" | "synthetic"
  parts: OrchestrationTranscriptPart[]
}

export type OrchestrationModelTurnRequest = {
  systemPrompt: string
  activeSkillInstructions: string[]
  tools: OrchestrationTool[]
  transcript: OrchestrationTranscriptMessage[]
  signal: AbortSignal
}

export type OrchestrationModelEvent =
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

export type OrchestrationModelPort = {
  streamTurn(request: OrchestrationModelTurnRequest): AsyncIterable<OrchestrationModelEvent>
}
