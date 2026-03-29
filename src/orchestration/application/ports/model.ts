import type { OrchestrationTranscriptMessage } from "./session"
import type {
  OrchestrationActiveSkill,
  OrchestrationSkillCatalogEntry,
} from "./skill"
import type { OrchestrationTool } from "./tool"

export type OrchestrationModelTurnRequest = {
  systemPrompt: string
  skillCatalog: OrchestrationSkillCatalogEntry[]
  activeSkills: OrchestrationActiveSkill[]
  tools: OrchestrationTool[]
  transcript: OrchestrationTranscriptMessage[]
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
      type: "tool.call"
      callId: string
      name: string
      inputText: string
    }

export type OrchestrationModelPort = {
  streamTurn(request: OrchestrationModelTurnRequest): AsyncIterable<OrchestrationModelEvent>
}
