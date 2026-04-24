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
  source?: ModelSkillSource
  overrides?: ModelSkillCatalogOverride[]
}

export type ModelSkillSource = "builtin" | "global" | "workspace"

export type ModelSkillCatalogOverride = {
  source: ModelSkillSource
  path: string
}

export type ModelSkillPackageMetadata = {
  entryPath?: string
  baseDir?: string
  source?: ModelSkillSource
  files?: string[]
}

export type ModelActiveSkill = ModelSkillPackageMetadata & {
  name: string
  instructions: string
}

export type ModelSystemReminderMetadata = {
  catalogSkillNames: string[]
  activeSkillNames: string[]
  recoveryFilePaths: string[]
}

export type ReasoningEffortMode = "default" | "low" | "medium" | "high"

export type ModelThinkingConfig = {
  enabled: boolean
  effort?: ReasoningEffortMode
}

export type ModelProjectionInput = {
  systemPrompt: string
  lateContextMessage?: string
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
  temperature?: number
  thinking?: ModelThinkingConfig
}
