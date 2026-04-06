import type { ZodTypeAny } from "zod"
import type { ModelMessage, ModelTranscriptMessage } from "./message"

export type ModelTool = {
  name: string
  description: string
  inputSchema?: ZodTypeAny
}

export type ModelSkillCatalogEntry = {
  name: string
  description: string
  path: string
}

export type ModelActiveSkill = {
  name: string
  instructions: string
}

export type ModelSystemReminderMetadata = {
  catalogSkillNames: string[]
  activeSkillNames: string[]
  recoveryFilePaths: string[]
}

export type ModelProjectionInput = {
  systemPrompt: string
  skillCatalog: ModelSkillCatalogEntry[]
  activeSkills: ModelActiveSkill[]
  systemReminders?: string[]
  systemReminderMetadata?: ModelSystemReminderMetadata
  contextWindow?: number
  tools: ModelTool[]
  transcript: ModelTranscriptMessage[]
  compressibleToolNames?: ReadonlySet<string>
}

export type ModelTurnRequest = {
  system: string
  messages: ModelMessage[]
  tools: ModelTool[]
  signal: AbortSignal
}
