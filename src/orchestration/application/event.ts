export type OrchestrationRuntimeEvent =
  | {
      type: "run.started"
      runId: string
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
      reason: "activation" | "prompt"
    }
  | {
      type: "skill.load.completed"
      skillName: string
      skillPath: string
      instructionsLength: number
      reason: "activation" | "prompt"
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
      type: "run.completed"
      runId: string
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
