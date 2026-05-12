import type { OrchestrationTimelineMessage } from "./session"
import type {
  OrchestrationActiveSkill,
  OrchestrationSkillCatalogEntry,
} from "./skill"
import type { OrchestrationTool } from "./tool"

export type OrchestrationModelTurnRequest = {
  thinking?: {
    enabled: boolean
    effort?: "default" | "low" | "medium" | "high"
  }
  systemPrompt: string
  lateContextMessage?: string
  skillCatalog: OrchestrationSkillCatalogEntry[]
  activeSkills: OrchestrationActiveSkill[]
  systemReminders?: string[]
  systemReminderMetadata?: {
    catalogSkillNames: string[]
    activeSkillNames: string[]
    recoveryFilePaths: string[]
  }
  contextWindow?: number
  temperature?: number
  tools: OrchestrationTool[]
  timeline: OrchestrationTimelineMessage[]
  compressibleToolNames?: ReadonlySet<string>
  sessionId?: string
  runId?: string
  turnKey?: string
  signal: AbortSignal
}

export type OrchestrationModelEvent =
  | {
      type: "text.delta"
      text: string
    }
  | {
      type: "reasoning.delta"
      text: string
    }
  | {
      type: "tool.call"
      callId: string
      name: string
      inputText: string
    }
  | {
      type: "usage"
      inputTokens: number
      outputTokens: number
      source: "provider" | "estimated"
    }

export type OrchestrationModelPort = {
  projectTurn?(request: Omit<OrchestrationModelTurnRequest, "signal">): {
    inputTokens: number
  }
  streamTurn(request: OrchestrationModelTurnRequest): AsyncIterable<OrchestrationModelEvent>
  continueWithoutThinking?(input: { sessionId: string }): void
  restoreThinking?(input: { sessionId: string }): void
}
