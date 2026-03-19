import type { OrchestrationSessionPort } from "../ports/session"
import type { OrchestrationModelPort } from "../ports/model"
import type { OrchestrationPermissionPort, OrchestrationPermissionResponse } from "../ports/permission"
import type { OrchestrationToolPort, OrchestrationToolPortFactory } from "../ports/tool"
import type { ActiveRunRegistry, ResolvedPermissionPolicy } from "../repo"
import { createOrchestrationStepService } from "./step"

type OrchestrationRuntimeEventPayload =
  | {
      type: "run.started"
      runId: string
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

export type OrchestrationEventEmitter = (event: OrchestrationRuntimeEventPayload) => void

export type OrchestrationRunSuspension = {
  isPending(requestId: string): boolean
  requestPermission(input: {
    toolName: string
    reason: string
  }): Promise<OrchestrationPermissionResponse>
  respond(input: OrchestrationPermissionResponse): void
  cancel(error?: Error): void
}

export type CreateOrchestrationRuntimeApiInput = {
  model: OrchestrationModelPort
  session: OrchestrationSessionPort
  permission: OrchestrationPermissionPort
  tools: OrchestrationToolPortFactory
  activeRuns: ActiveRunRegistry<OrchestrationRunSuspension, OrchestrationEventEmitter>
  permissionPolicy: ResolvedPermissionPolicy
  systemPrompt?: string
  now?: () => number
}

export type OrchestrationRunInput = {
  sessionId: string
  runId: string
}

export type OrchestrationLoopInput = {
  sessionId: string
  runId: string
  signal: AbortSignal
  emit: OrchestrationEventEmitter
  tools: OrchestrationToolPort
  workspaceRoot: string
  systemPrompt: string
  stepService: ReturnType<typeof createOrchestrationStepService>
}

export { createOrchestrationStepService } from "./step"
