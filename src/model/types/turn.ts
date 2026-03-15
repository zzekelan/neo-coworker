import type { ZodTypeAny } from "zod"
import type { ModelMessage, ModelTranscriptMessage } from "./message"

export type ModelTool = {
  name: string
  description: string
  inputSchema?: ZodTypeAny
}

export type ModelProjectionInput = {
  systemPrompt: string
  activeSkillInstructions: string[]
  tools: ModelTool[]
  transcript: ModelTranscriptMessage[]
}

export type ModelTurnRequest = {
  system: string
  messages: ModelMessage[]
  tools: ModelTool[]
  signal: AbortSignal
}
