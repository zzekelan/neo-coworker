import { z } from "zod"
import type { OrchestrationModelPort } from "../ports/model"
import type {
  OrchestrationPermissionDecision,
  OrchestrationPermissionMode,
  OrchestrationPermissionPort,
  OrchestrationPermissionResponse,
} from "../ports/permission"
import type { OrchestrationSessionPort } from "../ports/session"
import type { OrchestrationToolPort, OrchestrationToolPortFactory } from "../ports/tool"
import {
  createInMemoryActiveRunRegistry,
  resolvePermissionPolicy,
  type ActiveRunRegistry,
  type PermissionPolicyInput,
  type ResolvedPermissionPolicy,
} from "../repo"
import { createOrchestrationStepService } from "./step"

export type {
  OrchestrationModelEvent,
  OrchestrationModelPort,
  OrchestrationModelTurnRequest,
} from "../ports/model"
export type {
  OrchestrationPendingPermissionRequest,
  OrchestrationPermissionCoordinator,
  OrchestrationPermissionDecision,
  OrchestrationPermissionMode,
  OrchestrationPermissionPort,
  OrchestrationPermissionRequestRecord,
  OrchestrationPermissionResponse,
  OrchestrationPermissionStatus,
} from "../ports/permission"
export type {
  OrchestrationMessageRecord,
  OrchestrationPartRecord,
  OrchestrationRunRecord,
  OrchestrationRunStatus,
  OrchestrationSessionPort,
  OrchestrationSessionRecord,
  OrchestrationTranscriptMessage,
  OrchestrationTranscriptPart,
} from "../ports/session"
export type {
  OrchestrationTool,
  OrchestrationToolExecutionInput,
  OrchestrationToolExecutionResult,
  OrchestrationToolPort,
  OrchestrationToolPortFactory,
  RequestOrchestrationToolPermission,
} from "../ports/tool"

export const OrchestrationRunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  trigger: z.enum(["cli"]),
  status: z.enum([
    "queued",
    "running",
    "waiting_permission",
    "completed",
    "failed",
    "cancelled",
  ]),
})

export const RunSchema = OrchestrationRunSchema

export type OrchestrationRun = z.infer<typeof OrchestrationRunSchema>
export type Run = OrchestrationRun

export type OrchestrationRuntimeEvent =
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

export type RuntimeEvent = OrchestrationRuntimeEvent

export type OrchestrationRunPermissionDecision = OrchestrationPermissionDecision
export type OrchestrationRunPermissionResponse = OrchestrationPermissionResponse

export type OrchestrationRunHandle = {
  events: AsyncIterable<RuntimeEvent>
  cancel(): void | Promise<void>
  respondPermission(input: OrchestrationRunPermissionResponse): void | Promise<void>
}

export type RunHandle = OrchestrationRunHandle

export type OrchestrationEventEmitter = (event: OrchestrationRuntimeEvent) => void

export type OrchestrationRunSuspension = {
  isPending(requestId: string): boolean
  requestPermission(input: {
    toolName: string
    reason: string
  }): Promise<OrchestrationPermissionResponse>
  respond(input: OrchestrationPermissionResponse): void
  cancel(error?: Error): void
}

export type OrchestrationPermissionPolicy = ResolvedPermissionPolicy
export type OrchestrationPermissionPolicyInput = PermissionPolicyInput
export type OrchestrationPermissionPolicyMode = OrchestrationPermissionMode
export type OrchestrationResolvedPermissionPolicy = ResolvedPermissionPolicy

export type OrchestrationActiveRunRegistry = ActiveRunRegistry<
  OrchestrationRunSuspension,
  OrchestrationEventEmitter
>

export type CreateOrchestrationRuntimeApiInput = {
  model: OrchestrationModelPort
  session: OrchestrationSessionPort
  permission: OrchestrationPermissionPort
  tools: OrchestrationToolPortFactory
  activeRuns: OrchestrationActiveRunRegistry
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

export function createOrchestrationActiveRunRegistry(): OrchestrationActiveRunRegistry {
  return createInMemoryActiveRunRegistry()
}

export { createOrchestrationStepService } from "./step"
export { resolvePermissionPolicy }
