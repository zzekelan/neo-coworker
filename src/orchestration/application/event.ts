export type OrchestrationRuntimeEvent =
  | {
      type: "run.started"
      runId: string
    }
  | {
      type: "capability.resolution.recorded"
      model: string
      provider: "openai" | "openai-compatible"
      providerFamily: "kimi" | "generic"
      catalogSource: "models.dev" | "default"
      catalogMiss: boolean
      reasoningSource: "config" | "models.dev" | "default"
      toolCallSource: "config" | "models.dev" | "default"
      interleavedSource: "config" | "models.dev" | "default"
      interleavedField: "reasoning_content" | "reasoning_details" | null
      reasoningEffortSource: "config" | "models.dev" | "default"
      thinkingSource: "config" | "models.dev" | "default"
      thinkingEffortSource: "config" | "models.dev" | "default"
    }
  | {
      type: "context.window.resolved"
      contextWindow: number
      source: "config" | "/models" | "models.dev" | "default"
    }
  | {
      type: "skill.run.snapshot.applied"
      activeSkillNames: string[]
      activeSkillCount: number
    }
  | {
      type: "skill.catalog.exposed"
      catalogSkillNames: string[]
      catalogSkillCount: number
    }
  | {
      type: "skill.load.requested"
      skillName: string
      reason: "activation" | "prompt" | "recovery"
    }
  | {
      type: "skill.load.completed"
      skillName: string
      skillPath: string
      instructionsLength: number
      reason: "activation" | "prompt" | "recovery"
    }
  | {
      type: "skill.activated"
      skillName: string
      activeSkillNames: string[]
      activeSkillCount: number
    }
  | {
      type: "message.started"
      role: "assistant"
    }
  | {
      type: "message.delta"
      text: string
    }
  | {
      type: "model.turn.retrying"
      attempt: number
      error: string
    }
  | {
      type: "context.usage.updated"
      sessionId: string
      runId: string
      contextTokens: number
      contextWindow: number
      utilizationPercent: number
      source: "provider" | "estimated" | null
    }
  | {
      type: "compaction.completed"
      trigger: "auto" | "manual"
      summarizeRunId: string
      tokensBefore: number
      tokensAfter: number
      compressionRatio: number
    }
  | {
      type: "compaction.failed"
      trigger: "auto" | "manual"
      error: string
      attemptCount: number
      summarizeRunId: string | null
    }
  | {
      type: "compaction.circuit_breaker.triggered"
      consecutiveFailures: number
      lastError: string
      resolution: "manual_compact"
    }
  | {
      type: "permission.requested"
      requestId: string
      toolName: string
      reason: string
    }
  | {
      type: "tool.call.completed"
      callId: string
      name: string
      output: string
    }
  | {
      type: "tool.progress"
      toolCallId: string
      message: string
      timestamp: number
    }
  | {
      type: "run.completed"
      runId: string
    }
  | {
      type: "kimi.run.classified"
      model: string
      outcome: "success" | "failure"
    }
  | {
      type: "run.failed"
      runId: string
      error: string
    }
  | {
      type: "run.cancelled"
      runId: string
    }

export type RuntimeEvent = OrchestrationRuntimeEvent
