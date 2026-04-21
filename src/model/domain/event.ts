import type { ModelUsageEvent } from "./usage"

export type ModelEvent =
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
  | ModelUsageEvent
