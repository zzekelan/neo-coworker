import type { OrchestrationModelPort } from "../ports/model"
import type { OrchestrationPermissionPort, OrchestrationPermissionResponse } from "../ports/permission"
import type { OrchestrationSessionPort } from "../ports/session"
import type { OrchestrationToolPort, OrchestrationToolPortFactory } from "../ports/tool"
import {
  createInMemoryActiveRunRegistry,
  type ActiveRunRegistry,
} from "../repo/active-run-registry"
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
export { resolvePermissionPolicy } from "../repo/policy"
const orchestrationRunContracts = await import("../types/run")

export const OrchestrationRunSchema = orchestrationRunContracts.OrchestrationRunSchema
export const RunSchema = orchestrationRunContracts.RunSchema

export type OrchestrationPermissionPolicyMode = import("../types/permission").OrchestrationPermissionPolicyMode
export type OrchestrationRunPermissionDecision = import("../types/permission").OrchestrationRunPermissionDecision
export type OrchestrationRunPermissionResponse = import("../types/permission").OrchestrationRunPermissionResponse
export type OrchestrationPermissionPolicy = import("../types/permission").OrchestrationPermissionPolicy
export type OrchestrationPermissionPolicyInput = import("../types/permission").OrchestrationPermissionPolicyInput
export type OrchestrationRuntimeEvent = import("../types/event").OrchestrationRuntimeEvent
export type RuntimeEvent = import("../types/event").RuntimeEvent
export type OrchestrationRunHandle = import("../types/handle").OrchestrationRunHandle
export type RunHandle = import("../types/handle").RunHandle
export type OrchestrationRun = import("../types/run").OrchestrationRun
export type Run = import("../types/run").Run

export type OrchestrationEventEmitter = (event: RuntimeEvent) => void

export type OrchestrationRunSuspension = {
  isPending(requestId: string): boolean
  requestPermission(input: {
    toolName: string
    reason: string
  }): Promise<OrchestrationPermissionResponse>
  respond(input: OrchestrationPermissionResponse): void
  cancel(error?: Error): void
}

export type OrchestrationResolvedPermissionPolicy = OrchestrationPermissionPolicy

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
  permissionPolicy: OrchestrationPermissionPolicy
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
